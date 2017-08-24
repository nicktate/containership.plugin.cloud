'use strict';

const constants = require('./constants');

const request = require('request');
const scheduler = require('node-schedule');

class ClusterSnapshot {

    constructor() {
        this.job = null;
    }

    setup(core, cache, config) {
        this.cancel();

        if(cache.snapshotting_configuration && cache.snapshotting_configuration.schedule) {
            const snapshot_options = {
                api_key: config.api_key,
                cluster_id: core.cluster_id,
                organization: config.organization,
                notes: cache.snapshotting_configuration.notes,
                persist_data: cache.snapshotting_configuration.persist_data
            };

            this.job = scheduler.scheduleJob(cache.snapshotting_configuration.schedule, () => {
                this.request(snapshot_options, (err, snapshot_details) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('error', `Failed to create cluster snapshot: ${err.message}`);
                    } else {
                        core.loggers['containership-cloud'].log('verbose', `Successfully created cluster snapshot: ${snapshot_details.id} (${snapshot_details.notes})`);
                    }
                });
            });
        } else if(cache.snapshotting_configuration) {
            core.loggers['containership-cloud'].log('error', 'Invalid snapshotting configuration! Refusing to setup cluster snapshotting!');
        }
    }

    cancel() {
        if(this.job) {
            this.job.cancel();
        }
    }

    request(snapshot_options, callback) {
        const options = {
            url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${snapshot_options.organization}/backups`,
            method: 'POST',
            timeout: 5000,
            headers: {
                Authorization: `Bearer ${snapshot_options.api_key}`
            },
            json: {
                cluster_id: snapshot_options.cluster_id,
                notes: snapshot_options.notes || `Scheduled ContainerShip Cloud Snapshot (${new Date().toISOString()})`,
                persist_data: snapshot_options.persist_data
            }
        };

        request(options, (err, response) => {
            if(err) {
                return callback(err);
            } else if(response && response.statusCode !== 201) {
                return callback(new Error(`Received ${response.statusCode} response from API!`));
            } else {
                return callback(null, response.body);
            }
        });
    }
}

module.exports = new ClusterSnapshot();
