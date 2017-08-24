'use strict';

const aws = require('./integrations').aws;
const constants = require('./constants');
const crypto = require('./crypto');
const Firewall = require('./firewall');
const SSH_Keys = require('./ssh_keys');

const _ = require('lodash');
const async = require('async');
const request = require('request');
const tar = require('tar');
const tarfs = require('tar-fs');
const url = require('url');

module.exports = {

    initialize: function(core, config) {
        const firewall = new Firewall(core);
        firewall.enable();

        core.cluster.legiond.join('containership-cloud.backup');

        // enable SSH key management
        new SSH_Keys(core);

        // enables registry authentication
        core.scheduler.follower.container.add_pre_pull_middleware('docker', 'authentication', function(options, pre_pull_middleware_callback) {
            options.auth = [];

            core.cluster.myriad.persistence.get(constants.myriad.REGISTRIES, (err, registries) => {
                if(err) {
                    core.loggers['containership-cloud'].log('error', `Error reading registries from myriad-kv: ${err.message}`);
                    registries = {};
                } else {
                    try {
                        registries = JSON.parse(registries);
                    } catch(err) {
                        core.loggers['containership-cloud'].log('error', `Error parsing registries from myriad-kv: ${err.message}`);
                        registries = [];
                    }
                }

                const cs_registry_url = url.parse(constants.environment.CLOUD_REGISTRY_BASE_URL);

                registries.push({
                    username: config.organization,
                    password: config.api_key,
                    serveraddress: cs_registry_url.host,
                    auth: ''
                });

                let registry_domain;
                const image_parts = options.image.split('/');

                if(image_parts.length === 2 && !image_parts[0].includes('.')) {
                    registry_domain = 'docker.io';
                } else {
                    registry_domain = image_parts[0];
                }

                return async.each(registries, (registry, fn) => {
                    // this checks to see if the server address begins with the registry domain of the image being pulled
                    // http/https in the serveraddress is optional, and it must match the entire serveraddress's domain
                    // although it can optionally continue with a path proceeded by a /
                    if(new RegExp(`^((https|http)://)?${registry_domain}($|/)`).test(registry.serveraddress)) {
                        if(registry.provider === 'amazon_ec2_registry') {
                            const aws_options = {
                                aws_access_key_id: registry.username,
                                aws_secret_access_key: registry.password,
                                region: registry.email
                            };

                            return aws.get_authorization(aws_options, (err, data) => {
                                if(err) {
                                    return fn();
                                }

                                let decrypted_token = Buffer.from(data.authorizationToken, 'base64').toString('ascii');
                                const username_password = decrypted_token.split(':');

                                options.auth.push({
                                    authconfig: {
                                        email: '',
                                        username: username_password[0],
                                        password: username_password[1],
                                        serveraddress: data.proxyEndpoint,
                                        auth: ''
                                    }
                                });
                                return fn();
                            });
                        }

                        options.auth.push({
                            authconfig: {
                                email: registry.email,
                                username: registry.username,
                                password: registry.password,
                                serveraddress: registry.serveraddress,
                                auth: ''
                            }
                        });
                        return fn();
                    } else {
                        return fn();
                    }
                }, () => {
                    // need to set an empty auth objct to pull public images
                    if(!options.auth.length) {
                        options.auth.push({});
                    }

                    return pre_pull_middleware_callback();
                });
            });
        });

        // set ContainerShip Cloud specific environment variables
        core.scheduler.follower.container.add_pre_start_middleware('docker', 'csc_env', function(container_options, fn) {
            let application_name = container_options.application_name;
            let container = _.omit(container_options, ['application_name', 'start_args']);

            const dns_hash = crypto.md5(`${config.organization}.${core.cluster_id}`);
            const dns_entry = `${application_name}.${dns_hash}.dns.cship.co`;

            container.env_vars[`CS_CLOUD_DNS_ADDRESS_${application_name.toUpperCase()}`] = dns_entry;
            container.env_vars.CS_CLOUD_ORGANIZATION_ID = config.organization;

            core.cluster.myriad.persistence.get(constants.myriad.CLUSTER_DETAILS, (err, cluster_details) => {
                if(err) {
                    core.loggers['containership-cloud'].log('error', `Error reading cluster details from myriad-kv: ${err.message}`);
                } else {
                    try {
                        cluster_details = JSON.parse(cluster_details);

                        if(cluster_details.environment) {
                            container.env_vars.CSC_ENV = cluster_details.environment;
                        }
                    } catch(err) {
                        core.loggers['containership-cloud'].log('error', `Error parsing cluster details from myriad-kv: ${err.message}`);
                    }
                }

                core.cluster.myriad.persistence.set([core.constants.myriad.CONTAINERS_PREFIX, application_name, container.id].join(core.constants.myriad.DELIMITER), JSON.stringify(container), function() {
                    return fn();
                });
            });
        });

        // download snapshot from ContainerShip Cloud
        core.scheduler.follower.container.add_pre_pull_middleware('docker', 'containership-cloud', function(container_options, fn) {
            if(_.has(container_options.env_vars, 'CSC_BACKUP_ID') && !_.isEmpty(container_options.volumes)) {

                let on_error = function(err) {
                    core.loggers['containership-cloud'].log('warn', 'Error downloading container snapshot');
                    core.loggers['containership-cloud'].log('error', err.message);
                };

                if(!container_options.tags || !container_options.tags.metadata || !container_options.tags.metadata.codexd || !container_options.tags.metadata.codexd.volumes) {
                    return fn();
                }

                async.forEach(_.keys(container_options.tags.metadata.codexd.volumes), (volume_id, fn) => {
                    let options = {
                        url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/backups/${container_options.env_vars.CSC_BACKUP_ID}/containers/${container_options.id}/volumes/${volume_id}`,
                        method: 'GET',
                        headers: {
                            Authorization: ['Bearer', config.api_key].join(' ')
                        }
                    };

                    let extract_tar = tar.Extract({path: `${core.cluster.codexd.options.base_path}/${volume_id}`}).on('error', on_error).on('end', function() {
                        core.cluster.codexd.create_volume({
                            id: volume_id
                        }, () => {
                            return fn();
                        });
                    });

                    request(options).pipe(extract_tar);
                }, fn);

            } else {
                return fn();
            }
        });

        // upload snapshot to ContainerShip Cloud
        core.cluster.legiond.on('containership-cloud.backup', function(message) {
            let options = {
                url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/backups/${message.data.backup_id}/containers/${message.data.container_id}/volumes/${message.data.volume_id}`,
                method: 'POST',
                headers: {
                    Authorization: ['Bearer', config.api_key].join(' ')
                }
            };

            tarfs.pack(message.data.path).pipe(request(options));
        });
    }

};
