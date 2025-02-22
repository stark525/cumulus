/* eslint-disable import/no-unresolved */

'use strict';

// handy script to delete any old test kinesis streams that are created but not
// cleaned up.

const aws = require('aws-sdk');
const moment = require('moment');
const kinesis = new aws.Kinesis();

const deleteOlderThanDays = 1;

function getStreams() {
  return kinesis.listStreams({})
    .promise()
    .then((result) => result.StreamNames);
}

function filterOld(streams) {
  const matcher = /(Error|Trigger|SourceTest|KinesisReplayTest)-(\d{13})-(Kinesis|Lambda|Replay)/;
  const results = streams.map((s) => {
    if (s.match(matcher)) {
      const streamDate = Number(s.match(matcher)[2]);
      if (moment().diff(streamDate, 'days') > deleteOlderThanDays) {
        return s;
      }
    }
    return undefined;
  });
  return results.filter((r) => r);
}

/** stagger retries from 25 to 30 seconds */
function randomInterval() {
  return Math.floor(Math.random() * 5000 + 25000);
}

async function nukeStream(streamName) {
  console.log(`nuking: ${streamName}`);
  try {
    return await kinesis.deleteStream({ StreamName: streamName }).promise();
  } catch (error) {
    if (error.code === 'LimitExceededException') {
      const delay = randomInterval();
      console.log(`Limit exceeded...waiting ${delay / 1000} seconds and retrying to delete ${streamName}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return nukeStream(streamName);
    }
    throw error;
  }
}

function nukeStreams(listStreams) {
  console.log(`deleting ${listStreams.length} streams...`);
  return Promise.all(listStreams.map((s) => nukeStream(s)));
}

async function runReaper() {
  return getStreams()
    .then(filterOld)
    .then(nukeStreams);
}

module.exports = {
  runReaper,
};
