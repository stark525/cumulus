'use strict';

const test = require('ava');
const sinon = require('sinon');
const got = require('got');
const isEqual = require('lodash/isEqual');
const omit = require('lodash/omit');
const request = require('supertest');
const {
  EcsStartTaskError,
} = require('@cumulus/errors');
const { localStackConnectionEnv } = require('@cumulus/db');
const awsServices = require('@cumulus/aws-client/services');
const {
  buildS3Uri,
  fileExists,
  parseS3Uri,
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const asyncOperations = require('@cumulus/async-operations');
const { randomId } = require('@cumulus/common/test-utils');
const {
  createFakeJwtAuthToken,
  fakeReconciliationReportFactory,
  setAuthorizedOAuthUsers,
} = require('../../lib/testUtils');
const assertions = require('../../lib/assertions');
const models = require('../../models');
const bootstrap = require('../../lambdas/bootstrap');
const indexer = require('../../es/indexer');
const {
  Search,
} = require('../../es/search');

process.env = { ...process.env, ...localStackConnectionEnv };
process.env.invoke = 'granule-reconciliation-reports';
process.env.stackName = 'test-stack';
process.env.system_bucket = 'testsystembucket';
process.env.AccessTokensTable = randomId('accessTokensTable');
process.env.AsyncOperationsTable = randomId('asyncOperationsTable');
process.env.ReconciliationReportsTable = randomId('recReportsTable');
process.env.TOKEN_SECRET = randomId('tokenSecret');
process.env.stackName = randomId('stackname');
process.env.system_bucket = randomId('systemBucket');
process.env.invokeReconcileLambda = randomId('invokeReconcileLambda');
process.env.AsyncOperationTaskDefinition = randomId('asyncOpTaskDefinition');
process.env.EcsCluster = randomId('ecsCluster');

// import the express app after setting the env variables
const {
  app,
} = require('../../app');
const { normalizeEvent } = require('../../lib/reconciliationReport/normalizeEvent');

let esClient;
const esIndex = randomId('esindex');

let jwtAuthToken;
let accessTokenModel;
let asyncOperationsModel;
let reconciliationReportModel;
let fakeReportRecords = [];

test.before(async () => {
  // create esClient
  esClient = await Search.es('fakehost');

  const esAlias = randomId('esalias');
  process.env.ES_INDEX = esAlias;

  // add fake elasticsearch index
  await bootstrap.bootstrapElasticSearch('fakehost', esIndex, esAlias);

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  reconciliationReportModel = new models.ReconciliationReport();
  await reconciliationReportModel.createTable();

  asyncOperationsModel = new models.AsyncOperation({
    stackName: process.env.stackName,
    systemBucket: process.env.system_bucket,
  });
  await asyncOperationsModel.createTable();

  await awsServices.s3().createBucket({
    Bucket: process.env.system_bucket,
  }).promise();

  const username = randomId('username');
  await setAuthorizedOAuthUsers([username]);

  jwtAuthToken = await createFakeJwtAuthToken({
    accessTokenModel,
    username,
  });

  const reportNameTypes = [
    { name: randomId('report1'), type: 'Inventory' },
    { name: randomId('report2'), type: 'Granule Inventory' },
    { name: randomId('report3'), type: 'Internal' },
  ];

  const reportDirectory = `${process.env.stackName}/reconciliation-reports`;
  const typeToExtension = (type) => ((type === 'Granule Inventory') ? '.csv' : '.json');

  fakeReportRecords = reportNameTypes.map((nameType) => fakeReconciliationReportFactory({
    name: nameType.name,
    type: nameType.type,
    location: buildS3Uri(process.env.system_bucket,
      `${reportDirectory}/${nameType.name}${typeToExtension(nameType.type)}`),
  }));

  // add report records to database and report files go to s3
  // the first and second record have report files in s3, the report file for third one is mssing
  await Promise.all(fakeReportRecords.slice(0, 2).map((reportRecord) =>
    awsServices.s3().putObject({
      ...parseS3Uri(reportRecord.location),
      Body: JSON.stringify({
        test_key: `${reportRecord.name} test data`,
      }),
    }).promise()));

  // add records to es
  await Promise.all(fakeReportRecords.map((reportRecord) =>
    reconciliationReportModel.create(reportRecord)
      .then((record) => indexer.indexReconciliationReport(esClient, record, esAlias))));
});

test.after.always(async () => {
  await accessTokenModel.deleteTable();
  await reconciliationReportModel.deleteTable();
  await asyncOperationsModel.deleteTable();
  await esClient.indices.delete({
    index: esIndex,
  });
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
});

test.serial('CUMULUS-911 GET without pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/reconciliationReports')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-911 GET with pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/reconciliationReports/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-911 POST without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .post('/reconciliationReports')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-911 DELETE with pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .delete('/reconciliationReports/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-911 GET without pathParameters and with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/reconciliationReports')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('CUMULUS-911 GET without pathParameters and with an unauthorized user returns an unauthorized response');

test.serial('CUMULUS-911 GET with pathParameters and with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/reconciliationReports/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('CUMULUS-911 GET with pathParameters and with an unauthorized user returns an unauthorized response');

test.serial('CUMULUS-911 POST with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .post('/reconciliationReports')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('CUMULUS-911 POST with an unauthorized user returns an unauthorized response');

test.serial('CUMULUS-911 DELETE with pathParameters and with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .delete('/reconciliationReports/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('CUMULUS-911 DELETE with pathParameters and with an unauthorized user returns an unauthorized response');

test.serial('default returns list of reports', async (t) => {
  const response = await request(app)
    .get('/reconciliationReports')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const results = response.body;
  t.is(results.results.length, 3);

  const recordsAreEqual = (record1, record2) =>
    isEqual(omit(record1, ['updatedAt', 'timestamp']), omit(record2, ['updatedAt', 'timestamp']));

  results.results.forEach((item) => {
    const recordsFound = fakeReportRecords.filter((record) => recordsAreEqual(record, item));
    t.is(recordsFound.length, 1);
  });
});

test.serial('get a Inventory report with s3 signed url', async (t) => {
  const record = fakeReportRecords[0];
  const response = await request(app)
    .get(`/reconciliationReports/${record.name}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);
  const report = await got(response.body.presignedS3Url).json();
  t.deepEqual(report, {
    test_key: `${record.name} test data`,
  });
  t.deepEqual(response.body.data, report);
});

test.serial('get a Granule Inventory report with s3 signed url', async (t) => {
  const record = fakeReportRecords[1];
  const response = await request(app)
    .get(`/reconciliationReports/${record.name}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);
  const report = await got(response.body.presignedS3Url).text();
  t.deepEqual(report, JSON.stringify({
    test_key: `${record.name} test data`,
  }));
  t.deepEqual(response.body.data, report);
});

test.serial('get a report which exceeds maximum allowed payload size', (t) => {
  process.env.maxResponsePayloadSize = 150;
  return Promise.all(fakeReportRecords.slice(0, 2).map(async (record) => {
    const response = await request(app)
      .get(`/reconciliationReports/${record.name}`)
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .expect(200);
    const report = await got(response.body.presignedS3Url).text();
    t.deepEqual(report, JSON.stringify({
      test_key: `${record.name} test data`,
    }));
    t.true(response.body.data.includes('exceeded maximum allowed payload size'));
  }));
});

test.serial('get 404 if the report record doesnt exist', async (t) => {
  const response = await request(app)
    .get('/reconciliationReports/404record')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);
  t.is(response.status, 404);
  t.is(response.body.message, 'No record found for 404record');
});

test.serial('get 404 if the report file doesnt exist', async (t) => {
  const response = await request(app)
    .get(`/reconciliationReports/${fakeReportRecords[2].name}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);
  t.is(response.status, 404);
  t.is(response.body.message, 'The report does not exist!');
});

test.serial('delete a report', (t) =>
  Promise.all(fakeReportRecords.map(async (record) => {
    const response = await request(app)
      .delete(`/reconciliationReports/${record.name}`)
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .expect(200);
    t.deepEqual(response.body, {
      message: 'Report deleted',
    });

    const parsed = parseS3Uri(record.location);
    const exists = await fileExists(parsed.Bucket, parsed.Key);
    t.false(exists);
  })));

test.serial('create a report starts an async operation', async (t) => {
  const id = randomId('id');
  const stub = sinon.stub(asyncOperations, 'startAsyncOperation').resolves({
    id,
  });
  const stackName = process.env.stackName;
  const systemBucket = process.env.system_bucket;
  const tableName = process.env.AsyncOperationsTable;
  try {
    const response = await request(app)
      .post('/reconciliationReports')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .expect(202);

    t.deepEqual(response.body, {
      id,
    });

    t.true(stub.calledWith({
      asyncOperationTaskDefinition: process.env.AsyncOperationTaskDefinition,
      cluster: process.env.EcsCluster,
      lambdaName: process.env.invokeReconcileLambda,
      description: 'Create Reconciliation Report',
      operationType: 'Reconciliation Report',
      payload: normalizeEvent({}),
      useLambdaEnvironmentVariables: true,
      stackName,
      systemBucket,
      dynamoTableName: tableName,
      knexConfig: process.env,
    }));
  } finally {
    stub.restore();
  }
});

test.serial('POST returns a 500 when failing to create an async operation', async (t) => {
  const stub = sinon.stub(asyncOperations, 'startAsyncOperation').throws(
    new Error('failed to start')
  );

  try {
    const response = await request(app)
      .post('/reconciliationReports')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`);
    t.is(response.status, 500);
  } finally {
    stub.restore();
  }
});

test.serial('POST returns a 503 when there is an ecs error', async (t) => {
  const asyncOperationStartStub = sinon.stub(asyncOperations, 'startAsyncOperation').throws(
    new EcsStartTaskError('failed to start')
  );

  try {
    const response = await request(app)
      .post('/reconciliationReports')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .send({});
    t.is(response.status, 503);
  } finally {
    asyncOperationStartStub.restore();
  }
});

test.serial('create a report with invalid payload errors immediately', async (t) => {
  const stub = sinon.stub(asyncOperations, 'startAsyncOperation');
  const payload = {
    startTimestamp: '2020-09-17T16:38:23.973Z',
    collectionId: ['a-collectionId'],
    granuleId: ['a-granuleId'],
  };

  try {
    const response = await request(app)
      .post('/reconciliationReports')
      .send(payload)
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .expect(400);

    t.deepEqual(
      response.body,
      {
        error: 'Bad Request',
        message: 'Inventory reports cannot be launched with more than one input (granuleId, collectionId, or provider).',
        name: 'InvalidArgument',
        statusCode: 400,
      }
    );

    t.true(stub.notCalled);
  } finally {
    stub.restore();
  }
});
