'use strict';

const constants = require('./lib/constants');

const _ = require('lodash');
const fs = require('fs');
const request = require('request');

module.exports = {

    discover: function(callback) {
        let config = {};

        fs.readFile([process.env.HOME, '.containership', 'cloud.json'].join('/'), function(err, content) {
            if (err) {
                return callback(err);
            }

            try {
                config = JSON.parse(content);
            } catch(err) {
                return callback(err);
            }

            fs.readFile(['', 'opt', 'containership', 'cluster_id'].join('/'), function(err, content) {
                if(err) {
                    return callback(err);
                }

                try {
                    config = _.merge(config, JSON.parse(content));
                } catch(err) {
                    return callback(err);
                }

                containership_cloud.get_configuration(config, function(err, response) {
                    if(err) {
                        return callback(err);
                    } else if(!cloud[response.general.provider]) {
                        return callback(new Error('Provider does not exist!'));
                    }

                    return callback(null, cloud[response.general.provider].parse(response));
                });
            });

        });

        let containership_cloud = {

            get_configuration: function(config, fn) {
                let options = {
                    baseUrl: constants.CLOUD_API_BASE_URL,
                    url: ['', 'v2', 'organizations', config.organization, 'clusters', config.cluster_id, 'configuration'].join('/'),
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: ['Bearer', config.api_key].join(' ')
                    },
                    json: true
                };

                request(options, function(err, response) {
                    if(err) {
                        return fn(err);
                    } else if(response.statusCode != 200) {
                        return fn(new Error(response.body));
                    } else {
                        return fn(null, response.body);
                    }
                });
            }

        };

        let cloud = {

            aws: {
                parse: function(configuration) {
                    let ip_addresses = _.flatten([
                        _.pluck(configuration.leaders.instances, 'PrivateIpAddress'),
                        _.pluck(configuration.followers.instances, 'PrivateIpAddress')
                    ]);

                    return _.map(ip_addresses, function(ip_address) {
                        ip_address = [ip_address, '32'].join('/');
                        return ip_address;
                    });
                }
            },

            do: {
                parse: function(configuration) {
                    let ip_addresses = _.flatten([
                        _.map(configuration.leaders.instances, function(instance) {
                            if(_.isNull(instance)) {
                                return;
                            }

                            let ip_address = null;
                            _.each(instance.networks.v4, function(network) {
                                if(network.type == 'private') {
                                    ip_address = network.ip_address;
                                }
                            });

                            ip_address = [ip_address, '32'].join('/');
                            return ip_address;
                        }),
                        _.map(configuration.followers.instances, function(instance) {
                            if(_.isNull(instance)) {
                                return;
                            }

                            let ip_address = null;
                            _.each(instance.networks.v4, function(network) {
                                if(network.type == 'private') {
                                    ip_address = network.ip_address;
                                }
                            });

                            ip_address = [ip_address, '32'].join('/');
                            return ip_address;
                        })
                    ]);

                    return _.compact(ip_addresses);
                }
            },

            joy: {
                parse: function(configuration) {
                    return _.flatten([
                        _.map(configuration.leaders.instances, function(instance) {
                            let ip_address = _.without(instance.ips, instance.primaryIp);
                            ip_address = [ip_address, '32'].join('/');
                            return ip_address;
                        }),
                        _.map(configuration.followers.instances, function(instance) {
                            let ip_address = _.without(instance.ips, instance.primaryIp);
                            ip_address = [ip_address, '32'].join('/');
                            return ip_address;
                        })
                    ]);
                }
            },

            pkt: {
                parse: function(configuration) {
                    return _.flatten([
                        _.map(configuration.leaders.instances, function(instance) {
                            let ip_address = _.find(instance.ip_addresses, function(ip) {
                                return !ip.public;
                            });
                            ip_address = [ip_address.address, '32'].join('/');
                            return ip_address;
                        }),
                        _.map(configuration.followers.instances, function(instance) {
                            let ip_address = _.find(instance.ip_addresses, function(ip) {
                                return !ip.public;
                            });
                            ip_address = [ip_address.address, '32'].join('/');
                            return ip_address;
                        })
                    ]);
                }
            },

            rsp: {
                parse: function(configuration) {
                    return _.flatten([
                        _.map(configuration.leaders.instances, function(instance) {
                            return [_.first(instance.addresses.private).addr, '32'].join('/');
                        }),
                        _.map(configuration.followers.instances, function(instance) {
                            return [_.first(instance.addresses.private).addr, '32'].join('/');
                        })
                    ]);
                }
            },

            google_cloud: {
                parse: function(configuration) {
                    let ips = _.map(_.flatten([configuration.leaders.instances, configuration.followers.instances]), function(instance) {
                        if(instance.metadata && instance.metadata.networkInterfaces) {
                            let nics = _.indexBy(instance.metadata.networkInterfaces, 'name');
                            return nics.nic0 && `${nics.nic0.networkIP}/32`;
                        }
                    });

                    return _.compact(ips);
                }
            },

            soft_layer: {
                parse: function(configuration) {
                    const ips = _.map(_.flatten([configuration.leaders.instances, configuration.followers.instances]), function(instance) {
                        if (instance.primaryBackendIpAddress) {
                            return `${instance.primaryBackendIpAddress}/32`;
                        }
                    });

                    return _.compact(ips);
                }
            },

            linode: {
                parse: function(configuration) {
                    let ips = _.map(_.flatten([configuration.leaders.instances, configuration.followers.instances]), function(instance) {
                        if(instance.IP && instance.IP.private && instance.IP.private.IPADDRESS) {
                            return `${instance.IP.private.IPADDRESS}/32`;
                        }
                    });

                    return _.compact(ips);
                }
            },

            oracle_cloud: {
                parse: function(configuration) {
                    return _.map(_.flatten([configuration.leaders.instances, configuration.followers.instances]), function(instance) {
                        return `${instance.ip}/32`;
                    });
                }
            },

            azure: {
                parse: function(configuration) {
                    return _.map(_.flatten([configuration.leaders.instances, configuration.followers.instances]), function(instance) {
                        if(instance.networkInterfaces && instance.networkInterfaces.ipConfigurations) {
                            return `${instance.networkInterfaces.ipConfigurations[0].privateIPAddress}/32`;
                        }
                    });
                }
            }
        };


        cloud.amazon_web_services = cloud.aws;
        cloud.digital_ocean = cloud.do;
        cloud.joyent = cloud.joy;
        cloud.packet = cloud.pkt;
        cloud.rackspace = cloud.rsp;
    }

};
