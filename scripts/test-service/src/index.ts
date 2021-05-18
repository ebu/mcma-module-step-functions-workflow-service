import * as fs from "fs";
import * as path from "path";
import * as mime from "mime-types";

import { v4 as uuidv4 } from "uuid";
import * as AWS from "aws-sdk";

import { AuthProvider, ResourceManager } from "@mcma/client";
import { Job, JobParameterBag, JobProfile, JobStatus, McmaException, McmaTracker, Utils, WorkflowJob } from "@mcma/core";
import { AwsS3FileLocator } from "@mcma/aws-s3";
import { awsV4Auth } from "@mcma/aws-client";

const AWS_CREDENTIALS = "../../deployment/aws-credentials.json";
const TERRAFORM_OUTPUT = "../../deployment/terraform.output.json";

AWS.config.loadFromPath(AWS_CREDENTIALS);

const s3 = new AWS.S3();

async function uploadFileToBucket(bucket: string, filename: string) {
    const fileStream = fs.createReadStream(filename);
    fileStream.on("error", function (err) {
        console.log("File Error", err);
    });

    const uploadParams: AWS.S3.PutObjectRequest = {
        Bucket: bucket,
        Key: path.basename(filename),
        Body: fileStream,
        ContentType: mime.lookup(filename) || "application/octet-stream"
    };

    await s3.upload(uploadParams).promise();

    return new AwsS3FileLocator({
        bucket: uploadParams.Bucket,
        key: uploadParams.Key,
        url: s3.getSignedUrl("getObject", {
            Bucket: uploadParams.Bucket,
            Key: uploadParams.Key,
            Expires: 3600
        })
    });
}

async function waitForJobCompletion(job: Job, resourceManager: ResourceManager): Promise<Job> {
    console.log("Job is " + job.status);

    while (job.status !== JobStatus.Completed &&
           job.status !== JobStatus.Failed &&
           job.status !== JobStatus.Canceled) {

        await Utils.sleep(1000);
        job = await resourceManager.get<Job>(job.id);
        console.log("Job is " + job.status);
    }

    return job;
}

async function startWorkflowJob(resourceManager: ResourceManager) {
    let [jobProfile] = await resourceManager.query(JobProfile, { name: "TestWorkflow" });

    // if not found bail out
    if (!jobProfile) {
        throw new McmaException("JobProfile 'TestWorkflow' not found");
    }

    let distributionJob = new WorkflowJob({
        jobProfileId: jobProfile.id,
        jobInput: new JobParameterBag({

        }),
        tracker: new McmaTracker({
            "id": uuidv4(),
            "label": "Test - TestWorkflow"
        })
    });

    return resourceManager.create(distributionJob);
}

async function testWorkflowJob(resourceManager: ResourceManager) {
    let job;

    console.log("Creating job");
    job = await startWorkflowJob(resourceManager);

    console.log("job.id = " + job.id);
    job = await waitForJobCompletion(job, resourceManager);

    console.log(JSON.stringify(job, null, 2));
}

async function main() {
    console.log("Starting test workflow service");

    const terraformOutput = JSON.parse(fs.readFileSync(TERRAFORM_OUTPUT, "utf8"));

    const servicesUrl = terraformOutput.service_registry.value.services_url;
    const servicesAuthType = terraformOutput.service_registry.value.auth_type;
    const servicesAuthContext: any | undefined = undefined;

    const resourceManagerConfig = {
        servicesUrl,
        servicesAuthType,
        servicesAuthContext
    };

    let resourceManager = new ResourceManager(resourceManagerConfig, new AuthProvider().add(awsV4Auth(AWS)));

    await testWorkflowJob(resourceManager);
}

main().then(() => console.log("Done")).catch(e => console.error(e));
