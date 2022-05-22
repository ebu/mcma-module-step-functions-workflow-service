import * as fs from "fs";
import * as AWS from "aws-sdk";
import { default as axios } from "axios";
import { McmaException, Utils } from "@mcma/core";
import { AwsV4Authenticator } from "@mcma/aws-client";
import { HttpClient } from "@mcma/client";

const { AwsProfile, AwsRegion, ModuleRepository } = process.env;

const credentials = new AWS.SharedIniFileCredentials({ profile: AwsProfile });
AWS.config.credentials = credentials;
AWS.config.region = AwsRegion;

export function log(entry?: any) {
    if (typeof entry === "object") {
        console.log(JSON.stringify(entry, null, 2));
    } else {
        console.log(entry);
    }
}

function validURL(str: string) {
    const pattern = new RegExp("^(https?:\\/\\/)?" + // protocol
                               "((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|" + // domain name
                               "((\\d{1,3}\\.){3}\\d{1,3}))" + // OR ip (v4) address
                               "(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*" + // port and path
                               "(\\?[;&a-z\\d%_.~+=-]*)?" + // query string
                               "(\\#[-a-z\\d_]*)?$", "i"); // fragment locator
    return !!pattern.test(str);
}

async function main() {
    log("Publishing to Module Repository");
    log("Repository: " + ModuleRepository);

    const module = JSON.parse(fs.readFileSync("../../aws/build/staging/module.json").toString());
    log("Module:");
    log(module);

    if (validURL(ModuleRepository)) {
        const httpClient = new HttpClient(new AwsV4Authenticator({
            accessKey: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            region: AwsRegion,
        }));
        const postResponse = await httpClient.post(module, `${ModuleRepository}/api/modules/publish`);
        const { publishUrl } = postResponse.data;

        await axios.put(publishUrl, fs.readFileSync("../../aws/build/dist/module.zip"), {
            transformRequest: [(data, headers) => {
                if (headers) {
                    delete (headers.put as any)["Content-Type"];
                }
                return data;
            }]
        });

        let done = false;
        do {
            try {
                const getResponse = await httpClient.get(`${ModuleRepository}/api/modules/${module.namespace}/${module.name}/${module.provider}/${module.version}`);
                log(getResponse.data);
                done = true;
            } catch (error) {
                log("Waiting for module to be available in module repository...");
                await Utils.sleep(5000);
            }
        } while (!done);
    } else {
        const s3 = new AWS.S3();

        const objectKey = `${module.namespace}/${module.name}/aws/${module.version}/module.zip`;

        log("Checking if version already exists");
        let exists = true;
        try {
            await s3.headObject({
                Bucket: ModuleRepository,
                Key: objectKey
            }).promise();
        } catch {
            exists = false;
        }
        if (exists) {
            throw new McmaException("Version already exists in module repository. Change the version number!");
        }

        log("Uploading AWS version");
        try {
            await s3.upload({
                Bucket: ModuleRepository,
                Key: objectKey,
                Body: fs.createReadStream("../../aws/build/dist/module.zip"),
                ACL: "public-read"
            }).promise();
        } catch (error) {
            // in case of a private bucket with restrictions we just try again without public-read ACL
            await s3.upload({
                Bucket: ModuleRepository,
                Key: objectKey,
                Body: fs.createReadStream("../../aws/build/dist/module.zip")
            }).promise();
        }
    }
}

main().then(() => log("Done")).catch(reason => console.error(reason));
