'use strict';

const cli = require('./lib/cli');
const cluster_discovery = require('./cluster_discovery');
const constants = require('./lib/constants');
const follower = require('./lib/follower');
const leader = require('./lib/leader');
const logger = require('./lib/logger');

const _ = require('lodash');
const ContainershipPlugin = require('containership.plugin');
const url = require('url');

const APPLICATION_NAME = 'containership-cloud';

module.exports = new ContainershipPlugin({
    type: ['core', 'cli'],
    name: 'cloud',

    // cli version 2
    cli: require('./lib/cli-v2'),

    runCLI: function() {
        let commands = _.map(cli, function(configuration, command) {
            configuration.name = command;
            return configuration;
        });

        return {
            commands: commands,
            middleware: [
                function(options, fn) {
                    if(options.url.indexOf(constants.environment.CLOUD_API_BASE_URL) === 0) {
                        let original_url = options.url;
                        options.url = [
                            constants.environment.CLOUD_API_BASE_URL,
                            'v2',
                            'organizations',
                            options.headers['x-containership-cloud-organization'],
                            'clusters',
                            options.headers['x-containership-cloud-cluster'],
                            'proxy'
                        ].join('/');

                        let original_method = options.method;
                        options.method = 'POST';

                        options.headers = _.pick(options.headers, [
                            'authorization'
                        ]);

                        let original_qs = options.qs;
                        options.qs = {};

                        let original_body = options.json;

                        let proxy_url = url.parse(original_url).path.split('/');
                        proxy_url.splice(1, 1);

                        options.json = {
                            url: proxy_url.join('/'),
                            qs: original_qs,
                            method: original_method
                        };

                        if((original_method === 'POST' || original_method === 'PUT') && !_.isUndefined(original_body)) {
                            options.json.data = original_body;
                        }
                    }

                    return fn();
                }
            ]
        };
    },

    runLeader: function(core) {
        module.exports._initialize(core, leader);
    },

    runFollower: function(core) {
        module.exports._initialize(core, follower);
    },

    initialize: function(core) {
        if(!core || !core.logger) {
            return module.exports.runCLI();
        } else if(core.options.mode === 'leader') {
            return module.exports.runLeader(core);
        } else if(core.options.mode === 'follower') {
            return module.exports.runFollower(core);
        } else if(core.logger) {
            core.logger.register(APPLICATION_NAME);
            core.loggers[APPLICATION_NAME].log('error', 'Invalid configuration found when initializing containership cloud plugin!');
        }
    },

    _initialize: function(core, hostMode) {
        core.logger.register(APPLICATION_NAME);

        let config = this.get_config('core');

        cluster_discovery.discover(core.cluster_id || core.options.cluster_id, config, function(err, cidr) {
            if(err) {
                core.loggers[APPLICATION_NAME].log('error', err.message);
            } else {
                core.loggers[APPLICATION_NAME].log('debug', `Discovering peers: ${cidr.join(', ')}`);

                core.cluster.legiond.options.network.cidr = cidr;
                core.cluster.legiond.actions.discover_peers(cidr);
            }

            hostMode.initialize(core, config);
        });
    },

    stop: function(core) {
        if(!core || !core.logger) {
            return logger.warn('CLI does not support stop');
        } else if(core && core.logger && core.options.mode === 'leader') {
            return module.exports.stopLeader(core);
        } else if(core && core.logger && core.options.mode === 'follower') {
            return module.exports.stopFollower(core);
        } else if(core.logger) {
            core.loggers[APPLICATION_NAME].log('error', 'Invalid configuration found when stopping containership cloud plugin!');
        }
    },

    stopLeader: function(core) {
        core.loggers[APPLICATION_NAME].log('verbose', `${APPLICATION_NAME} is stopping leader.`);
        leader.stop();
    },

    stopFollower: function(core) {
        core.loggers[APPLICATION_NAME].log('verbose', `${APPLICATION_NAME} is stopping follower.`);
    },

    reload: function() {}
});
