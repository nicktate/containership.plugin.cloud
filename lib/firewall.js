'use strict';

const logger = require('./logger');
const constants = require('./constants');

const _ = require('lodash');
const async = require('async');
const os = require('os');
const Tesserarius = require('tesserarius');

const CLOUD_PROVIDER = process.env.CS_CLOUD_PROVIDER;

const PROVIDERS_SOURCE_IFACE = [
    'amazon_web_services'
];

const PROVIDERS_DESTINATION_IFACE = [
    'digital_ocean'
];

/**
 * Depending on the provider specific interface implemntation, the FW
 * rule to be set in order to only allow access between nodes on the cluster
 * needs to be toggles between a destination rule and a source rule for the
 * private IP of the current node. This is a hard list of tested providers
 * with the correctly configured fw flag. We default to destination because
 * that is the logical choice for standard iface setups.
 */
function getIfaceRuleKey() {
    if(PROVIDERS_DESTINATION_IFACE.indexOf(CLOUD_PROVIDER) >= 0) {
        return 'destination';
    }

    if(PROVIDERS_SOURCE_IFACE.indexOf(CLOUD_PROVIDER) >= 0) {
        return 'source';
    }

    return 'destination';
}

class Firewall {

    constructor(host) {
        this.host = host;
        this.privateInterface = this.host.getNetworkInterface() || 'eth1';

        // virtual interface will requests will stil hit actual interface
        if(this.privateInterface.indexOf(':') >= 0) {
            this.privateInterface = this.privateInterface.split(':')[0];
        }

        const ifaceAddrInfo = _.find(
            _.get(os.networkInterfaces(), this.privateInterface, []),
            (iface) => iface.family === 'IPv4'
        );

        if(!ifaceAddrInfo) {
            throw new Error('Could not determine private IP!');
        }

        this.privateIP = ifaceAddrInfo.address;

        if(this.host.orchestrator === 'kubernetes') {
            this.flannelInterface = this.host.getFlannelInterface() || 'flannel0';
            this.flannelBackendPort = this.host.getFlannelBackendPort() || 8285;
        }

        this.options = {
            chain: {
                input: 'CONTAINERSHIP-INPUT',
                forward: 'CONTAINERSHIP-FORWARD'
            },

            initial_rules: {
                input: [
                    {
                        comment: 'Accept all connections on loopback interface',
                        interface: 'lo',
                        policy: 'ACCEPT'
                    },
                    {
                        comment: 'Accept all connections on docker interface',
                        interface: 'docker0',
                        policy: 'ACCEPT'
                    },
                    {
                        comment: 'Accept all established and related connections',
                        policy: 'ACCEPT',
                        state: ['ESTABLISHED', 'RELATED']
                    },
                    {
                        comment: 'Accept connections to containership API on private interface',
                        interface: this.privateInterface,
                        destination_port: this.host.getApiPort().toString(),
                        [getIfaceRuleKey()]: this.privateIP,
                        mode: 'leader',
                        policy: 'ACCEPT',
                        protocol: 'tcp'
                    }
                ],

                forward: [
                    {
                        comment: 'Accept all connections on docker interface',
                        interface: 'docker0',
                        policy: 'ACCEPT'
                    },
                    {
                        comment: 'Accept all established and related connections',
                        policy: 'ACCEPT',
                        state: ['ESTABLISHED', 'RELATED']
                    }
                ]
            }
        };

        if(this.host.orchestrator === 'containership') {
            this.options.initial_rules.input.push({
                comment: 'Accept connections to legiond management port on private interface',
                destination_port: '2666',
                interface: this.legiond_interface,
                policy: 'ACCEPT',
                protocol: 'tcp'
            });

            this.options.initial_rules.input.push({
                comment: 'Accept connections to legiond port on private interface',
                destination_port: '2777',
                interface: this.legiond_interface,
                policy: 'ACCEPT',
                protocol: 'tcp'
            });
        }

        if(this.host.orchestrator === 'kubernetes') {
            this.options.initial_rules.input.push({
                comment: 'Accept connections to etcd management server on private interface',
                destination_port: '4451',
                [getIfaceRuleKey()]: this.privateIP,
                interface: this.privateInterface,
                policy: 'ACCEPT',
                protocol: 'tcp'
            });

            this.options.initial_rules.input.push({
                comment: 'Accept connections to etcd port on private interface',
                destination_port: '2379',
                [getIfaceRuleKey()]: this.privateIP,
                interface: this.privateInterface,
                policy: 'ACCEPT',
                protocol: 'tcp'
            });

            this.options.initial_rules.input.push({
                comment: 'Accept connections to etcd port',
                interface: this.privateInterface,
                destination_port: '2380',
                [getIfaceRuleKey()]: this.privateIP,
                policy: 'ACCEPT',
                protocol: 'tcp'
            });

            this.options.initial_rules.input.push({
                comment: 'Accept connections to kubernetes api from follower nodes',
                interface: this.privateInterface,
                destination_port: '8080',
                [getIfaceRuleKey()]: this.privateIP,
                mode: 'leader',
                policy: 'ACCEPT',
                protocol: 'tcp'
            });

            this.options.initial_rules.forward.push({
                comment: 'Accept flannel to docker',
                interface: this.flannelInterface,
                destination_interface: 'docker0',
                policy: 'ACCEPT'
            });
        }

        this.tesserarius = new Tesserarius();
    }

    // TODO implement subscribe functionality
    enable() {
        logger.info('Enabling firewall rules');

        const firewallSyncInterval = 15000;
        this.reset_rules((err) => {
            if(err) {
                logger.error('There was an error creating Containership firewall chains. Firewalls are not being synced.');
                return;
            }

            setInterval(() => {
                this.host.getApi().getDistributedKey(constants.myriad.FIREWALLS, (error, firewalls) => {
                    if(error) {
                        return logger.error(error);
                    }

                    logger.info('Syncing firewalls: ' + JSON.stringify(firewalls));
                    this.set_rules();
                });
            }, firewallSyncInterval);
        });
    }

    // TODO this should be okay
    set_rules() {
        // setup rule queue if necessary
        if(!this.rule_queue) {
            // force tesserarius.set_rules calls to execute with single concurrency
            this.rule_queue = async.queue((task, callback) => {
                logger.info('Updating firewall rules');

                if(task.chain === this.options.chain.input) {
                    return async.parallel({
                        host_rules: (cb) => {
                            return this.get_host_rules(cb);
                        },
                        cloud_rules: (cb) => {
                            return this.get_cloud_rules(cb);
                        }
                    }, (err, results) => {
                        if(err) {
                            logger.info('Unable to fetch cloud firewall rules!');
                            logger.info(err.message);
                        }

                        const host_rules = _.get(results, 'host_rules.input', []);
                        const cloud_rules = _.get(results, 'cloud_rules', []);
                        const rules = _.union(this.get_initial_rules().input, host_rules, cloud_rules);
                        this.tesserarius.set_rules(task.chain, rules, callback);
                    });
                } else if(task.chain === this.options.chain.forward) {
                    let rules;
                    async.series([
                        (callback) => {
                            return this.get_host_rules((err, host_rules) => {
                                if(err) {
                                    return callback(err);
                                }

                                const forward_host_rules = _.get(host_rules, 'forward', []);
                                rules = _.union(this.get_initial_rules().forward, forward_host_rules);
                                return callback();
                            });
                        },
                        (callback) => {
                            // only kubernetes has custom cloud forward chain rules
                            if(this.host.orchestrator !== 'kubernetes') {
                                return callback();
                            }

                            return this.get_cloud_forward_rules((err, cloud_forward_rules) => {
                                if(err) {
                                    logger.error(err);
                                    return callback();
                                }

                                rules = _.union(rules, cloud_forward_rules);
                                return callback();
                            });
                        },
                        (callback) => {
                            this.tesserarius.set_rules(task.chain, rules, callback);
                        },
                        (callback) => {
                            this.tesserarius.add_rule(task.chain, {
                                comment: 'Drop all other connections destined for the docker bridge',
                                policy: 'DROP'
                            }, callback);
                        }
                    ], callback);
                }
            }, 1);
        }

        // update chains
        _.forEach(this.options.chain, (containership_chain, chain) => {
            this.rule_queue.push({
                chain: containership_chain
            }, (err) => {
                if(err) {
                    logger.info(`Unable to apply new firewall rules to chain ${chain}!`);
                    logger.info(err.message);
                } else {
                    logger.info(`Sucessfully applied new firewall rules to chain ${chain}!`);
                }
            });
        });
    }

    get_initial_rules() {
        const rules = {
            input: [],
            forward: []
        };

        _.forEach(this.options.initial_rules, (chain_rules, chain) => {
            _.forEach(chain_rules, (rule) => {
                if(rule.mode && this.host.getOperatingMode() === rule.mode || !rule.mode) {
                    rules[chain].push(_.omit(rule, 'mode'));
                }
            });
        });

        return rules;
    }

    get_host_rules(cb) {
        const rules = {
            input: [],
            forward: []
        };

        return this.host.getApi().getHosts((err, peers) => {
            if(err) {
                return cb(err);
            }

            _.forEach(peers, (peer) => {
                _.forEach(_.keys(peer.address), (scope) => {
                    if(this.host.orchestrator === 'kubernetes') {
                        rules.input.push({
                            comment: `Accept connections to flannel communicates of ${this.flannelBackendPort} for backends`,
                            interface: this.privateInterface,
                            destination_port: this.flannelBackendPort,
                            policy: 'ACCEPT',
                            protocol: 'udp',
                            source: peer.address[scope]
                        });
                    }

                    if(this.host.isLeader()) {
                        rules.input.push({
                            comment: 'Accept connections to containership API from containership cluster peers',
                            destination_port: this.host.getApiPort().toString(),
                            policy: 'ACCEPT',
                            protocol: 'tcp',
                            source: peer.address[scope]
                        });
                    } else {
                        rules.input.push({
                            comment: 'Accept connections to service discovery port range from containership cluster peers',
                            destination_port: '0:65535',
                            policy: 'ACCEPT',
                            protocol: 'tcp',
                            source: peer.address[scope]
                        });

                        if(scope === this.legiond_scope) {
                            rules.forward.push({
                                comment: 'Accept connections to container port range from containership cluster peers',
                                policy: 'RETURN',
                                source: peer.address[scope],
                                interface: this.privateInterface
                            });
                        }
                    }
                });
            });
            return cb(null, rules);
        });
    }

    get_cloud_rules(callback) {
        return async.parallel({
            endpoints: (cb) => {
                if(this.host.orchestrator !== 'kubernetes') {
                    return setImmediate(cb);
                }

                return this.host.getApi().getServiceEndpoints(cb);
            },
            applications: (cb) => {
                if(this.host.orchestrator !== 'kubernetes') {
                    return setImmediate(cb);
                }

                return this.host.getApi().getApplications(cb);
            },
            firewalls: (cb) => this.host.getApi().getDistributedKey(constants.myriad.FIREWALLS, cb)
        }, (err, results) => {
            const default_firewall = {
                destination_port: '22',
                policy: 'ACCEPT',
                protocol: 'tcp',
                source: '0.0.0.0/0'
            };

            if(err) {
                return callback(err, [ default_firewall ]);
            }


            results.firewalls = _.map(results.firewalls, (rule) => {
                const additional_rules = [];


                if(this.host.orchestrator === 'kubernetes') {
                    const applications = results.applications || {};

                    if(rule.type === 'host' && (rule.host.type === 'mode' && (rule.host.mode === this.host.getOperatingMode() || rule.host.mode === 'all'))) {
                        const app_with_port = _.find(_.values(applications), { discovery_port: parseInt(rule.port) });

                        if(app_with_port) {
                            rule.application = app_with_port.name;
                            additional_rules.push(_.map(results.endpoints[rule.application], (endpoint) => {
                                const new_rule = {
                                    comment: rule.description || 'ContainerShip Cloud Service Endpoint Firewall Rule',
                                    destination: endpoint.ip,
                                    destination_port: endpoint.port.toString(),
                                    policy: 'ACCEPT',
                                    protocol: rule.protocol
                                };

                                if(rule.interface) {
                                    new_rule.interface = rule.interface;
                                }

                                if(rule.source !== '0.0.0.0/0') {
                                    new_rule.source = rule.source;
                                }

                                // todo: should we package this all in a new service specific chain and add it to the forward chain
                                return [new_rule];
                            }));
                        }
                    } else if(this.host.getOperatingMode() === 'follower' && rule.type === 'application') {
                        additional_rules.push(_.map(results.endpoints[rule.application], (endpoint) => {
                            const new_rule = {
                                comment: rule.description || 'ContainerShip Cloud Service Endpoint Firewall Rule',
                                destination: endpoint.ip,
                                destination_port: endpoint.port.toString(),
                                policy: 'ACCEPT',
                                protocol: rule.protocol
                            };

                            if(rule.interface) {
                                new_rule.interface = rule.interface;
                            }

                            if(rule.source !== '0.0.0.0/0') {
                                new_rule.source = rule.source;
                            }

                            // todo: should we package this all in a new service specific chain and add it to the forward chain
                            return [new_rule];
                        }));
                    }
                }

                if(rule.type !== 'host' || (rule.host.type === 'mode' && (rule.host.mode === this.host.getOperatingMode() || rule.host.mode === 'all'))) {
                    const new_rule = {
                        comment: rule.description || 'ContainerShip Cloud Firewall Rule',
                        destination_port: rule.port.toString(),
                        policy: 'ACCEPT',
                        protocol: rule.protocol
                    };

                    if(rule.interface) {
                        new_rule.interface = rule.interface;
                    }

                    if(rule.source !== '0.0.0.0/0') {
                        new_rule.source = rule.source;
                    }

                    additional_rules.push(new_rule);
                }

                return additional_rules;
            });

            return callback(null, _.compact(_.flattenDeep(results.firewalls)));
        });
    }

    get_cloud_forward_rules(callback) {
        // only set forward chain cloud rules on kubernetes for service routing
        if(this.host.orchestrator !== 'kubernetes' ) {
            return callback(null, []);
        }

        return async.parallel({
            applications: (cb) => this.host.getApi().getApplications(cb),
            endpoints: (cb) => this.host.getApi().getServiceEndpoints(cb),
            firewalls: (cb) => this.host.getApi().getDistributedKey(constants.myriad.FIREWALLS, cb)
        }, (err, results) => {
            if(err) {
                return callback(err, []);
            }

            const applications = results.applications;
            const endpoints = results.endpoints;

            results.firewalls = _.map(results.firewalls, (rule) => {
                const get_rules = () => {
                    return _.map(endpoints[rule.application], (endpoint) => {
                        const flannel_rule = {
                            comment: rule.description || 'ContainerShip Cloud Service Endpoint Firewall Rule',
                            destination: endpoint.ip,
                            destination_port: endpoint.port.toString(),
                            destination_interface: this.flannelInterface,
                            policy: 'ACCEPT',
                            protocol: rule.protocol
                        };

                        const docker0_rule = {
                            comment: rule.description || 'ContainerShip Cloud Service Endpoint Firewall Rule',
                            destination: endpoint.ip,
                            destination_port: endpoint.port.toString(),
                            destination_interface: 'docker0',
                            policy: 'ACCEPT',
                            protocol: rule.protocol
                        };

                        const private_flannel_rule = {
                            comment: rule.description || 'ContainerShip Cloud Service Endpoint Firewall Rule',
                            destination: endpoint.ip,
                            destination_port: endpoint.port.toString(),
                            destination_interface: this.flannelInterface,
                            interface: this.privateInterface,
                            policy: 'ACCEPT',
                            protocol: rule.protocol
                        };

                        const private_docker0_rule = {
                            comment: rule.description || 'ContainerShip Cloud Service Endpoint Firewall Rule',
                            destination: endpoint.ip,
                            destination_port: endpoint.port.toString(),
                            destination_interface: 'docker0',
                            interface: this.privateInterface,
                            policy: 'ACCEPT',
                            protocol: rule.protocol
                        };

                        const host_mode_rule = {
                            comment: rule.description || 'ContainerShip Cloud Service Endpoint Firewall Rule',
                            destination: endpoint.ip,
                            destination_port: endpoint.port.toString(),
                            destination_interface: this.privateInterface,
                            policy: 'ACCEPT',
                            protocol: rule.protocol
                        };

                        if(rule.interface) {
                            flannel_rule.interface = rule.interface;
                            docker0_rule.interface = rule.interface;
                        }

                        if(rule.source !== '0.0.0.0/0') {
                            flannel_rule.source = rule.source;
                            docker0_rule.source = rule.source;
                        }

                        // todo: should we package this all in a new service specific chain and add it to the forward chain
                        return [flannel_rule, docker0_rule, private_flannel_rule, private_docker0_rule, host_mode_rule];
                    });
                };

                if(rule.type === 'host' && (rule.host.type === 'mode' && (rule.host.mode === this.host.getOperatingMode() || rule.host.mode === 'all'))) {
                    const app_with_port = _.find(_.values(applications), { discovery_port: parseInt(rule.port) });

                    if(app_with_port) {
                        rule.application = app_with_port.name;

                        return get_rules();
                    }
                } else if(rule.type === 'application' && endpoints[rule.application] && this.host.getOperatingMode() === 'follower') {
                    return get_rules();
                }
            });

            return callback(null, _.compact(_.flattenDeep(results.firewalls)));
        });
    }

    reset_input_chain(callback) {
        const chain = 'INPUT';

        async.series([
            (callback) => {
                // set default policy on chain to 'ACCEPT'
                this.tesserarius.set_policy(chain, 'ACCEPT', callback);
            },
            (callback) => {
                // flush chain
                this.tesserarius.flush(chain, callback);
            },
            (callback) => {
                // flush Containership chain
                this.tesserarius.flush(this.options.chain.input, (err) => {
                    if(err) {
                        this.tesserarius.create_chain(this.options.chain.input, callback);
                    } else {
                        return callback();
                    }
                });
            },
            (callback) => {
                // set default Containership chain rules
                this.tesserarius.set_rules(this.options.chain.input, this.get_initial_rules().input, callback);
            },
            (callback) => {
                // add Containership chain
                this.tesserarius.set_rules(chain, [
                    {
                        policy: this.options.chain.input
                    }
                ], callback);
            },
            (callback) => {
                // set default policy on chain to 'DROP'
                this.tesserarius.set_policy(chain, 'DROP', callback);
            }
        ], (err) => {
            if(err) {
                logger.error(err);
                return callback(err);
            }

            return callback();
        });
    }

    reset_forward_chain(callback) {
        const chain = 'FORWARD';

        async.series([
            (callback) => {
                // set default policy on chain to 'ACCEPT'
                this.tesserarius.set_policy(chain, 'ACCEPT', callback);
            },
            (callback) => {
                // flush chain
                this.tesserarius.flush(chain, callback);
            },
            (callback) => {
                // flush Containership chain
                this.tesserarius.flush(this.options.chain.forward, (err) => {
                    if(err) {
                        this.tesserarius.create_chain(this.options.chain.forward, callback);
                    } else {
                        return callback();
                    }
                });
            },
            (callback) => {
                // set default Containership chain rules
                this.tesserarius.set_rules(this.options.chain.forward, this.get_initial_rules().forward, callback);
            },
            (callback) => {
                // add Containership chain
                this.tesserarius.set_rules(chain, [
                    {
                        policy: this.options.chain.forward
                    },
                    {
                        policy: 'DOCKER'
                    }
                ], callback);
            },
            (callback) => {
                // set default policy on chain to 'DROP'
                this.tesserarius.set_policy(chain, 'DROP', callback);
            }
        ], (err) => {
            if(err) {
                logger.error(err);
                return callback(err);
            }

            return callback();
        });
    }

    reset_rules(callback) {
        return async.series({
            reset_input_chain: async.retryable({times: 10, interval: 30000}, this.reset_input_chain.bind(this)),
            reset_forward_chain: async.retryable({times: 10, interval: 30000}, this.reset_forward_chain.bind(this))
        }, callback);
    }
}

module.exports = Firewall;
