'use strict';

const cluster_snapshot = require('./cluster_snapshot');
const constants = require('./constants');

const async = require('async');
const request = require('request');
const scheduler = require('node-schedule');

class AutoTermination {

    constructor() {
        this.job = null;
    }

    /**
     * Example auto-termination configuration:
     *
     * auto_termination_configuration: {
     *     schedule: '* * * * *',
     *     snapshot_configuration: {
     *         persist_data: true,
     *         enabled: true,
     *         cancel_termination_on_error: false
     *     }
     * }
     */

    schedule(core, cache, config) {
        this.cancel();

        if(cache.auto_termination_configuration && cache.auto_termination_configuration.schedule) {
            const termination_options = {
                api_key: config.api_key,
                cluster_id: core.cluster_id,
                organization: config.organization
            };

            const snapshot_options = {
                api_key: config.api_key,
                cluster_id: core.cluster_id,
                organization: config.organization,
                notes: (cache.auto_termination_configuration.snapshot_configuration && cache.auto_termination_configuration.snapshot_configuration.notes) || `Scheduled on Termination ContainerShip Cloud Snapshot (${new Date().toISOString()})`,
                persist_data: cache.auto_termination_configuration.snapshot_configuration && cache.auto_termination_configuration.snapshot_configuration.persist_data
            };

            this.job = scheduler.scheduleJob(cache.auto_termination_configuration.schedule, () => {
                async.series({
                    create_snapshot_before_terminating: (callback) => {
                        if(cache.auto_termination_configuration.snapshot_configuration && cache.auto_termination_configuration.snapshot_configuration.enabled) {
                            return cluster_snapshot.request(snapshot_options, (err) => {
                                if(err) {
                                    core.loggers['containership-cloud'].log('error', `Failed to create cluster snapshot: ${err.message}`);
                                    return cache.auto_termination_configuration.snapshot_configuration.cancel_termination_on_error ? callback(err) : callback();
                                }

                                return callback();
                            });
                        }

                        return callback();
                    }
                }, (err) => {
                    if(err) {
                        return core.loggers['containership-cloud'].log('error', 'There was an error creating snapshot. Refusing to terminate cluster!');
                    }

                    this.request(termination_options, (err) => {
                        if(err) {
                            core.loggers['containership-cloud'].log('error', `Failed to terminate: ${err.message}`);
                        } else {
                            core.loggers['containership-cloud'].log('verbose', `Successfully terminated cluster: ${termination_options.cluster_id}`);
                        }
                    });
                });
            });
        } else if(cache.auto_termination_configuration) {
            core.loggers['containership-cloud'].log('error', 'Invalid auto termination configuration! Refusing to terminate cluster!');
        }
    }

    cancel() {
        if(this.job) {
            this.job.cancel();
        }
    }

    request(termination_options, callback) {
        const options = {
            url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${termination_options.organization}/clusters/${termination_options.cluster_id}`,
            method: 'DELETE',
            timeout: 5000,
            headers: {
                Authorization: `Bearer ${termination_options.api_key}`
            }
        };

        request(options, (err, response) => {
            if(err) {
                return callback(err);
            } else if(response && response.statusCode !== 200) {
                return callback(new Error(`Received ${response.statusCode} response from API on cluster auto termination!`));
            } else {
                return callback();
            }
        });
    }
}

module.exports = new AutoTermination();
