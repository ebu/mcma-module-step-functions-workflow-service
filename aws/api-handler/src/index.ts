import { APIGatewayProxyEvent, Context } from "aws-lambda";
import * as AWSXRay from "aws-xray-sdk-core";

import { DefaultJobRouteCollection, HttpStatusCode, McmaApiRequestContext } from "@mcma/api";
import { DynamoDbTableProvider } from "@mcma/aws-dynamodb";
import { LambdaWorkerInvoker } from "@mcma/aws-lambda-worker-invoker";
import { AwsCloudWatchLoggerProvider } from "@mcma/aws-logger";
import { ApiGatewayApiController } from "@mcma/aws-api-gateway";
import { getWorkerFunctionId } from "@mcma/worker-invoker";
import { getTableName } from "@mcma/data";

const { LogGroupName } = process.env;

const AWS = AWSXRay.captureAWS(require("aws-sdk"));

const dbTableProvider = new DynamoDbTableProvider(new AWS.DynamoDB());
const loggerProvider = new AwsCloudWatchLoggerProvider("workflow-service-api-handler", LogGroupName, new AWS.CloudWatchLogs());
const workerInvoker = new LambdaWorkerInvoker(new AWS.Lambda());

async function processNotification(requestContext: McmaApiRequestContext) {
    const request = requestContext.request;

    const table = await dbTableProvider.get(getTableName());

    const jobAssignmentDatabaseId = "/job-assignments/" + request.pathVariables.id;

    const jobAssignment = await table.get(jobAssignmentDatabaseId);
    if (!jobAssignment) {
        requestContext.setResponseResourceNotFound();
        return;
    }

    const notification = requestContext.getRequestBody();
    if (!notification) {
        requestContext.setResponseBadRequestDueToMissingBody();
        return;
    }

    if (!notification.content) {
        requestContext.setResponseStatusCode(HttpStatusCode.BadRequest, "Missing notification content");
        return;
    }

    if (!notification.content.status) {
        requestContext.setResponseStatusCode(HttpStatusCode.BadRequest, "Missing notification content status");
        return;
    }

    const taskToken = request.queryStringParameters.taskToken;
    if (!taskToken) {
        requestContext.setResponseStatusCode(HttpStatusCode.BadRequest, "Missing 'taskToken' query string parameter");
        return;
    }

    await workerInvoker.invoke(
        getWorkerFunctionId(),
        {
            operationName: "ProcessNotification",
            input: {
                jobAssignmentDatabaseId,
                notification,
                taskToken,
            },
            tracker: jobAssignment.tracker,
        }
    );
}

const routes = new DefaultJobRouteCollection(dbTableProvider, workerInvoker)
    .addRoute("POST", "/job-assignments/{id}/notifications", processNotification);

const restController = new ApiGatewayApiController(routes, loggerProvider);

export async function handler(event: APIGatewayProxyEvent, context: Context) {
    console.log(JSON.stringify(event, null, 2));
    console.log(JSON.stringify(context, null, 2));

    const logger = loggerProvider.get(context.awsRequestId);
    try {
        logger.functionStart(context.awsRequestId);
        logger.debug(event);
        logger.debug(context);

        return await restController.handleRequest(event, context);
    } catch (error) {
        logger.error(error?.valueOf());
        throw error;
    } finally {
        logger.functionEnd(context.awsRequestId);

        console.log("LoggerProvider.flush - START - " + new Date().toISOString());
        const t1 = Date.now();
        await loggerProvider.flush(Date.now() + context.getRemainingTimeInMillis() - 5000);
        const t2 = Date.now();
        console.log("LoggerProvider.flush - END   - " + new Date().toISOString() + " - flush took " + (t2 - t1) + " ms");
    }
}
