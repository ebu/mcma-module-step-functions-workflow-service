import { APIGatewayProxyEvent, Context } from "aws-lambda";
import * as AWSXRay from "aws-xray-sdk-core";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";

import { DefaultJobRouteCollection, HttpStatusCode, McmaApiRequestContext } from "@mcma/api";
import { DynamoDbTableProvider } from "@mcma/aws-dynamodb";
import { LambdaWorkerInvoker } from "@mcma/aws-lambda-worker-invoker";
import { ApiGatewayApiController } from "@mcma/aws-api-gateway";
import { getWorkerFunctionId } from "@mcma/worker-invoker";
import { getTableName } from "@mcma/data";
import { ConsoleLoggerProvider } from "@mcma/core";

const dynamoDBClient = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const lambdaClient = AWSXRay.captureAWSv3Client(new LambdaClient({}));

const dbTableProvider = new DynamoDbTableProvider({}, dynamoDBClient);
const loggerProvider = new ConsoleLoggerProvider("workflow-service-api-handler");
const workerInvoker = new LambdaWorkerInvoker(lambdaClient);

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
        requestContext.setResponseError(HttpStatusCode.BadRequest, "Missing notification content");
        return;
    }

    if (!notification.content.status) {
        requestContext.setResponseError(HttpStatusCode.BadRequest, "Missing notification content status");
        return;
    }

    const taskToken = request.queryStringParameters.taskToken;
    if (!taskToken) {
        requestContext.setResponseError(HttpStatusCode.BadRequest, "Missing 'taskToken' query string parameter");
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
        logger.error(error);
        throw error;
    } finally {
        logger.functionEnd(context.awsRequestId);
    }
}
