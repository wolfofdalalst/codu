import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as backup from "aws-cdk-lib/aws-backup";
import * as events from "aws-cdk-lib/aws-events";
import * as kms from "aws-cdk-lib/aws-kms";
import { S3EventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";

interface Props extends cdk.StackProps {
  production?: boolean;
}

export class StorageStack extends cdk.Stack {
  public readonly bucket;
  public readonly db;
  public readonly vpc;

  constructor(scope: Construct, id: string, props?: Props) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "StorageStackVpc", {
      natGateways: 1,
    });

    const { vpc } = this;

    // S3 bucket
    const bucketName = ssm.StringParameter.valueForStringParameter(
      this,
      "/env/bucketname",
      1,
    );

    this.bucket = new s3.Bucket(this, "uploadBucket", {
      bucketName,
      removalPolicy: props?.production
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"], // TODO: Lock down on prod
          allowedHeaders: ["*"],
        },
      ],
    });

    // Custom domain setup
    const domainName = ssm.StringParameter.valueForStringParameter(
      this,
      `/env/domainName`,
      1,
    );

    const hostedZoneId = ssm.StringParameter.valueForStringParameter(
      this,
      `/env/hostedZoneId`,
      1,
    );

    const fullDomainName = `content.${domainName}`;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "MyZone", {
      hostedZoneId,
      zoneName: domainName,
    });

    const certificate = new acm.DnsValidatedCertificate(this, "Certificate", {
      domainName,
      subjectAlternativeNames: [`*.${domainName}`],
      hostedZone: zone,
      region: "us-east-1",
    });

    // CloudFront distribution setup
    const cloudFrontOAI = new cloudfront.OriginAccessIdentity(
      this,
      "CloudFrontOAI",
      {
        comment: `OAI for ${id}`,
      },
    );

    const distribution = new cloudfront.Distribution(
      this,
      "UploadDistribution",
      {
        defaultBehavior: {
          origin: new origins.S3Origin(this.bucket, {
            originAccessIdentity: cloudFrontOAI,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        domainNames: [fullDomainName],
        certificate: certificate,
      },
    );

    // Grant read permissions to CloudFront
    this.bucket.grantRead(cloudFrontOAI);

    new route53.ARecord(this, "SiteAliasRecord", {
      recordName: fullDomainName,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(distribution),
      ),
      zone,
    });

    // Lambda for resizing avatar uploads
    const s3AvatarEventHandler = new NodejsFunction(this, "ResizeAvatar", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "/../lambdas/avatarResize/index.js"),
      timeout: cdk.Duration.seconds(120),
      depsLockFilePath: path.join(
        __dirname,
        "/../lambdas/avatarResize/package-lock.json",
      ),
      bundling: {
        nodeModules: ["sharp", "@aws-sdk/client-s3"],
      },
    });

    // Lambda for resizing uploads
    const s3UploadEventHandler = new NodejsFunction(this, "ResizeUploads", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "/../lambdas/uploadResize/index.js"),
      timeout: cdk.Duration.seconds(120),
      depsLockFilePath: path.join(
        __dirname,
        "/../lambdas/uploadResize/package-lock.json",
      ),
      bundling: {
        nodeModules: ["sharp", "@aws-sdk/client-s3"],
      },
    });

    this.bucket.grantReadWrite(s3AvatarEventHandler);
    this.bucket.grantReadWrite(s3UploadEventHandler);

    s3AvatarEventHandler.addEventSource(
      new S3EventSource(this.bucket, {
        events: [s3.EventType.OBJECT_CREATED],
        filters: [{ prefix: "u/" }],
      }),
    );

    s3UploadEventHandler.addEventSource(
      new S3EventSource(this.bucket, {
        events: [s3.EventType.OBJECT_CREATED],
        filters: [{ prefix: "public/" }],
      }),
    );

    const dbUsername = ssm.StringParameter.valueForStringParameter(
      this,
      "/env/db/username",
      1,
    );

    const dbName = ssm.StringParameter.valueForStringParameter(
      this,
      "/env/db/name",
      1,
    );

    // RDS
    this.db = new rds.DatabaseInstance(this, "db-instance", {
      instanceIdentifier: "codu-rds",
      databaseName: dbName,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_14_5,
      }),
      credentials: rds.Credentials.fromPassword(
        dbUsername,
        cdk.SecretValue.ssmSecure("/env/db/password", "1"),
      ),
      vpc: vpc,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      publiclyAccessible: true,
      deletionProtection: props?.production ?? false,
      autoMinorVersionUpgrade: true,
      backupRetention: props?.production
        ? cdk.Duration.days(7) // 7 days retention for production
        : cdk.Duration.days(1), // 1 day retention for non-production (minimum allowed)
      preferredBackupWindow: "03:00-04:00", // UTC time
      deleteAutomatedBackups: props?.production ? false : true,
    });

    // Allow connections on default port from any IPV4
    // TODO: Lock down on prod
    this.db.connections.allowDefaultPortFromAnyIpv4();

    if (props?.production) {
      // Create a backup vault
      const backupVault = new backup.BackupVault(this, "MyBackupVault", {
        backupVaultName: "MyProductionDatabaseBackupVault",
        encryptionKey: new kms.Key(this, "MyBackupVaultKey"),
      });

      // Create a backup plan
      const plan = new backup.BackupPlan(this, "MyBackupPlan", {
        backupPlanName: "MyProductionDatabaseBackupPlan",
        backupVault: backupVault,
      });

      // Add a rule to the backup plan
      plan.addRule(
        new backup.BackupPlanRule({
          completionWindow: cdk.Duration.hours(2),
          startWindow: cdk.Duration.hours(1),
          scheduleExpression: events.Schedule.cron({
            // Set to 12:00 AM UTC every day
            minute: "0",
            hour: "0",
          }),
          deleteAfter: cdk.Duration.days(14), // Retain backups for 14 days
        }),
      );

      // Add the RDS instance as a resource to the backup plan
      plan.addSelection("MyBackupSelection", {
        resources: [backup.BackupResource.fromRdsDatabaseInstance(this.db)],
      });
    }
  }
}
