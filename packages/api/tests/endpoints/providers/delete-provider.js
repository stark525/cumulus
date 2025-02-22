'use strict';

const test = require('ava');
const request = require('supertest');
const { s3 } = require('@cumulus/aws-client/services');
const {
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { randomString } = require('@cumulus/common/test-utils');
const {
  destroyLocalTestDb,
  generateLocalTestDb,
  localStackConnectionEnv,
  translateApiProviderToPostgresProvider,
  translateApiRuleToPostgresRule,
  CollectionPgModel,
  RulePgModel,
  ProviderPgModel,
} = require('@cumulus/db');

const bootstrap = require('../../../lambdas/bootstrap');
const models = require('../../../models');
const {
  createFakeJwtAuthToken,
  fakeProviderFactory,
  setAuthorizedOAuthUsers,
} = require('../../../lib/testUtils');
const { Search } = require('../../../es/search');
const assertions = require('../../../lib/assertions');
const { fakeRuleFactoryV2 } = require('../../../lib/testUtils');
const testDbName = randomString(12);

process.env.ProvidersTable = randomString();
process.env.stackName = randomString();
process.env.system_bucket = randomString();
process.env.TOKEN_SECRET = randomString();
process.env = {
  ...process.env,
  ...localStackConnectionEnv,
  PG_DATABASE: testDbName,
};

// import the express app after setting the env variables
const { app } = require('../../../app');
const { migrationDir } = require('../../../../../lambdas/db-migration');

const esIndex = randomString();
let esClient;
let providerModel;

let jwtAuthToken;
let accessTokenModel;
let ruleModel;

test.before(async (t) => {
  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.testKnex = knex;
  t.context.testKnexAdmin = knexAdmin;

  t.context.collectionPgModel = new CollectionPgModel();
  t.context.providerPgModel = new ProviderPgModel();
  t.context.rulePgModel = new RulePgModel();

  process.env.stackName = randomString();

  process.env.system_bucket = randomString();
  await s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  const esAlias = randomString();
  process.env.ES_INDEX = esAlias;
  await bootstrap.bootstrapElasticSearch('fakehost', esIndex, esAlias);

  providerModel = new models.Provider();
  await providerModel.createTable();

  const username = randomString();
  await setAuthorizedOAuthUsers([username]);

  process.env.AccessTokensTable = randomString();
  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });

  esClient = await Search.es('fakehost');

  process.env.RulesTable = randomString();
  ruleModel = new models.Rule();
  await ruleModel.createTable();

  await s3().putObject({
    Bucket: process.env.system_bucket,
    Key: `${process.env.stackName}/workflow_template.json`,
    Body: JSON.stringify({}),
  }).promise();
});

test.beforeEach(async (t) => {
  t.context.testProvider = fakeProviderFactory();
  const createObject = await translateApiProviderToPostgresProvider(t.context.testProvider);
  [t.context.providerCumulusId] = await t.context.providerPgModel
    .create(
      t.context.testKnex,
      createObject
    );
  await providerModel.create(t.context.testProvider);
});

test.after.always(async (t) => {
  await providerModel.deleteTable();
  await accessTokenModel.deleteTable();
  await esClient.indices.delete({ index: esIndex });
  await ruleModel.deleteTable();
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await destroyLocalTestDb({
    knex: t.context.testKnex,
    knexAdmin: t.context.testKnexAdmin,
    testDbName,
  });
});

test('Attempting to delete a provider without an Authorization header returns an Authorization Missing response', async (t) => {
  const { testProvider } = t.context;

  const response = await request(app)
    .delete(`/providers/${testProvider.id}`)
    .set('Accept', 'application/json')
    .expect(401);

  t.is(response.status, 401);
  t.true(await providerModel.exists(testProvider.id));
});

test('Attempting to delete a provider with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .delete('/providers/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('Attempting to delete a provider with an unauthorized user returns an unauthorized response');

test('Deleting a provider removes the provider', async (t) => {
  const { testProvider } = t.context;
  const id = testProvider.id;
  await request(app)
    .delete(`/providers/${id}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.false(await providerModel.exists(testProvider.id));
  t.false(await t.context.providerPgModel.exists(t.context.testKnex, { name: id }));
});

test('Deleting a provider that does not exist succeeds', async (t) => {
  const { status } = await request(app)
    .delete(`/providers/${randomString}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);
  t.is(status, 200);
});

test('Attempting to delete a provider with an associated postgres rule returns a 409 response', async (t) => {
  const { testProvider } = t.context;
  const rule = fakeRuleFactoryV2({
    provider: testProvider.id,
    rule: {
      type: 'onetime',
    },
  });

  // The workflow message template must exist in S3 before the rule can be created
  await s3().putObject({
    Bucket: process.env.system_bucket,
    Key: `${process.env.stackName}/workflows/${rule.workflow}.json`,
    Body: JSON.stringify({}),
  }).promise();

  const collection = {
    name: randomString(10),
    version: '001',
    sample_file_name: 'fake',
    granule_id_validation_regex: 'fake',
    granule_id_extraction_regex: 'fake',
    files: {},
  };
  await t.context.collectionPgModel
    .create(
      t.context.testKnex,
      collection
    );

  await t.context.rulePgModel.create(
    t.context.testKnex,
    await translateApiRuleToPostgresRule(
      {
        ...rule,
        collection,
      },
      t.context.testKnex
    )
  );

  const response = await request(app)
    .delete(`/providers/${testProvider.id}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(409);

  t.is(response.status, 409);
  t.true(response.body.message.includes('Cannot delete provider with associated rules'));
});

test('Attempting to delete a provider with an associated rule returns a 409 response', async (t) => {
  const { testProvider } = t.context;

  const rule = fakeRuleFactoryV2({
    provider: testProvider.id,
    rule: {
      type: 'onetime',
    },
  });

  // The workflow message template must exist in S3 before the rule can be created
  await s3().putObject({
    Bucket: process.env.system_bucket,
    Key: `${process.env.stackName}/workflows/${rule.workflow}.json`,
    Body: JSON.stringify({}),
  }).promise();

  await ruleModel.create(rule);

  const response = await request(app)
    .delete(`/providers/${testProvider.id}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(409);

  t.is(response.status, 409);
  t.is(response.body.message, `Cannot delete provider with associated rules: ${rule.name}`);
});

test('Attempting to delete a provider with an associated rule does not delete the provider', async (t) => {
  const { testProvider } = t.context;

  const rule = fakeRuleFactoryV2({
    provider: testProvider.id,
    rule: {
      type: 'onetime',
    },
  });

  // The workflow message template must exist in S3 before the rule can be created
  await s3().putObject({
    Bucket: process.env.system_bucket,
    Key: `${process.env.stackName}/workflows/${rule.workflow}.json`,
    Body: JSON.stringify({}),
  }).promise();

  await ruleModel.create(rule);

  await request(app)
    .delete(`/providers/${testProvider.id}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(409);

  t.true(await providerModel.exists(testProvider.id));
});
