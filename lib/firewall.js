'use strict';

const constants = require('./constants');
const MyriadClient = require('./myriad');

const _ = require('lodash');
const async = require('async');
const semver = require('semver');
const Tesserarius = require('tesserarius');

class Firewall {

    constructor(core) {
        this.core = core;

        // ensure we get the physical network interface if legiond-interface is set to a virtual interface
        this.legiond_interface = this.core.options['legiond-interface'].split(':')[0];
        this.legiond_scope = this.core.options['legiond-scope'];

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
                        comment: 'Accept connections to legiond management port on private interface',
                        destination_port: 2666,
                        interface: this.legiond_interface,
                        policy: 'ACCEPT',
                        protocol: 'tcp'
                    },
                    {
                        comment: 'Accept connections to legiond port on private interface',
                        destination_port: 2777,
                        interface: this.legiond_interface,
                        policy: 'ACCEPT',
                        protocol: 'tcp'
                    },
                    {
                        comment: 'Accept connections to containership API on private interface',
                        interface: this.legiond_interface,
                        destination_port: this.core.options['api-port'],
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

        this.tesserarius = new Tesserarius();
        this.myriad_client = new MyriadClient(this.core);
    }

    enable() {
        const containership_version = this.myriad_client.get_containership_version();
        if(containership_version && semver.gte(containership_version, '1.8.0-0')) {
            this.reset_rules((err) => {
                if(err) {
                    this.core.loggers['containership-cloud'].log('error', 'Unable to reset firewall rules!');
                    this.core.loggers['containership-cloud'].log('debug', err.message);

                    // TODO: add notification that firewalls for this host are not configured as expected
                } else {
                    this.set_rules();

                    // force updates firewalls on full myriad sync
                    this.core.cluster.legiond.on('myriad.sync.full', () => {
                        this.set_rules();
                    });

                    const subscriber = this.myriad_client.subscribe(constants.myriad.FIREWALLS_REGEX);

                    subscriber.on('message', (message) => {
                        if(message.type === 'data') {
                            this.set_rules();
                        }
                    });

                    this.core.cluster.legiond.on('node_added', () => {
                        this.set_rules();
                    });
                    this.core.cluster.legiond.on('node_removed', () => {
                        this.set_rules();
                    });
                }
            });
        } else {
            this.core.loggers['containership-cloud'].log('error', 'Plugin requires version 1.8.0 of containership or greater! Refusing to enable the firewall!');
        }
    }

    set_rules() {
        // setup rule queue if necessary
        if(!this.rule_queue) {
            // force tesserarius.set_rules calls to execute with single concurrency
            this.rule_queue = async.queue((task, callback) => {
                this.core.loggers['containership-cloud'].log('verbose', 'Updating firewall rules');

                if(task.chain === this.options.chain.input) {
                    this.get_cloud_rules((err, cloud_rules) => {
                        if(err) {
                            this.core.loggers['containership-cloud'].log('error', 'Unable to fetch cloud firewall rules!');
                            this.core.loggers['containership-cloud'].log('debug', err.message);
                        }

                        const rules = _.union(this.get_initial_rules().input, this.get_host_rules().input, cloud_rules);
                        this.tesserarius.set_rules(task.chain, rules, callback);
                    });
                } else if(task.chain === this.options.chain.forward) {
                    const rules = _.union(this.get_initial_rules().forward, this.get_host_rules().forward);

                    async.series([
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
                    this.core.loggers['containership-cloud'].log('error', `Unable to apply new firewall rules to chain ${chain}!`);
                    this.core.loggers['containership-cloud'].log('debug', err.message);
                } else {
                    this.core.loggers['containership-cloud'].log('verbose', `Sucessfully applied new firewall rules to chain ${chain}!`);
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
                if(rule.mode && this.core.options.mode === rule.mode || !rule.mode) {
                    rules[chain].push(_.omit(rule, 'mode'));
                }
            });
        });

        return rules;
    }

    get_host_rules() {
        const rules = {
            input: [],
            forward: []
        };

        const peers = this.core.cluster.legiond.get_peers();

        _.forEach(peers, (peer) => {
            if(this.core.options.mode === 'leader') {
                _.forEach(peer.address, (address) => {
                    rules.input.push({
                        comment: 'Accept connections to containership API from containership cluster peers',
                        destination_port: this.core.options['api-port'],
                        policy: 'ACCEPT',
                        protocol: 'tcp',
                        source: address
                    });
                });
            } else {
                _.forEach(peer.address, (address, scope) => {
                    rules.input.push({
                        comment: 'Accept connections to service discovery port range from containership cluster peers',
                        destination_port: `${this.core.scheduler.options.loadbalancer.min_port}:${this.core.scheduler.options.loadbalancer.max_port}`,
                        policy: 'ACCEPT',
                        protocol: 'tcp',
                        source: address
                    });

                    if(scope === this.legiond_scope) {
                        rules.forward.push({
                            comment: 'Accept connections to container port range from containership cluster peers',
                            policy: 'RETURN',
                            source: address,
                            interface: this.legiond_interface
                        });
                    }
                });
            }
        });

        return rules;
    }

    get_cloud_rules(callback) {
        this.core.cluster.myriad.persistence.get(constants.myriad.FIREWALLS, (err, firewalls) => {
            const default_firewall = {
                destination_port: '22',
                policy: 'ACCEPT',
                protocol: 'tcp',
                source: '0.0.0.0/0'
            };

            if(err) {
                return callback(err, [ default_firewall ]);
            } else {
                try {
                    firewalls = JSON.parse(firewalls);

                    firewalls = _.map(firewalls, (rule) => {
                        if(rule.type !== 'host' || (rule.host.type === 'mode' && (rule.host.mode === this.core.options.mode || rule.host.mode === 'all'))) {
                            const new_rule = {
                                comment: rule.description || 'ContainerShip Cloud Firewall Rule',
                                destination_port: rule.port,
                                policy: 'ACCEPT',
                                protocol: rule.protocol
                            };

                            if(rule.interface) {
                                new_rule.interface = rule.interface;
                            }

                            if(rule.source !== '0.0.0.0/0') {
                                new_rule.source = rule.source;
                            }

                            return new_rule;
                        }
                    });

                    return callback(null, _.compact(firewalls));
                } catch(err) {
                    return callback(err, [ default_firewall ]);
                }
            }
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
        ], callback);
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
        ], callback);
    }

    reset_rules(callback) {
        this.reset_input_chain((err) => {
            if(err) {
                return callback(err);
            }

            this.reset_forward_chain(callback);
        });
    }

}

module.exports = Firewall;
