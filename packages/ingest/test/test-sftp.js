'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('ava');
const {
  calculateS3ObjectChecksum,
  fileExists,
  recursivelyDeleteS3Bucket,
  headObject,
  putFile
} = require('@cumulus/aws-client/S3');
const { s3 } = require('@cumulus/aws-client/services');
const { generateChecksumFromStream } = require('@cumulus/checksum');
const { randomString } = require('@cumulus/common/test-utils');
const SftpProviderClient = require('../SftpProviderClient');

const privateKey = 'ssh_client_rsa_key';
const bucket = randomString();
const stackName = randomString();

process.env.system_bucket = bucket;
process.env.stackName = stackName;

test.before(async () => {
  // let's copy the key to s3
  await s3().createBucket({ Bucket: bucket }).promise();

  await putFile(
    bucket,
    `${stackName}/crypto/${privateKey}`,
    `../test-data/keys/${privateKey}`
  );
});

test.beforeEach((t) => {
  t.context.mySftpProviderClient = new SftpProviderClient({
    host: '127.0.0.1',
    port: 2222,
    username: 'user',
    encrypted: false,
    privateKey
  });
});

test.after.always(async () => {
  await Promise.all([
    recursivelyDeleteS3Bucket(bucket)
  ]);
});

test('connect and retrieve list of pdrs', async (t) => {
  const { mySftpProviderClient } = t.context;

  const list = await mySftpProviderClient.list('');
  t.is(list.length > 0, true);
});

test('Download remote file to s3 with correct content-type', async (t) => {
  const { mySftpProviderClient } = t.context;

  const expectedContentType = 'application/x-hdf';

  const key = `${randomString()}.hdf`;
  await mySftpProviderClient.sync(
    '/granules/MOD09GQ.A2017224.h27v08.006.2017227165029.hdf', bucket, key
  );
  t.truthy(fileExists(bucket, key));
  const sum = await calculateS3ObjectChecksum({ algorithm: 'CKSUM', bucket, key });
  t.is(sum, 1435712144);

  const s3HeadResponse = await headObject(bucket, key);
  t.is(expectedContentType, s3HeadResponse.ContentType);
});

test('Download remote file to local disk', async (t) => {
  const { mySftpProviderClient } = t.context;

  const localPath = path.join(os.tmpdir(), `delete-me-${randomString()}.txt`);
  await mySftpProviderClient.download(
    '/granules/MOD09GQ.A2017224.h27v08.006.2017227165029.hdf', localPath
  );

  const sum = await generateChecksumFromStream('CKSUM', fs.createReadStream(localPath));
  t.is(sum, 1435712144);
  fs.unlinkSync(localPath);
});