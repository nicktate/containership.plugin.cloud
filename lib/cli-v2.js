/* eslint-disable no-console */
'use strict';

const configuration = require('./configuration');
const constants = require('./constants');
const github = require('./integrations/github');
const Table = require('./table');

const _ = require('lodash');
const async = require('async');
const chalk = require('chalk');
const flatten = require('flat');
const prmpt = require('prompt');
const request = require('request');

module.exports = {
    name: 'cloud',
    description: 'Containership cloud management client.',
    commands: []
};

function login(method) {
    prmpt.message = '';
    prmpt.delimiter = chalk.white(':');
    prmpt.start();

    async.waterfall([
        (callback) => {
            return prmpt.get([{
                name: 'username',
                description: chalk.white(method === 'github' ? 'Username' : 'Email'),
                required: true
            }, {
                name: 'password',
                description: chalk.white('Password'),
                hidden: true
            }], callback);
        },
        (credentials, callback) => {
            if(method === 'bitbucket') {
                return callback(null, credentials, false);
            }

            github.authenticate(credentials);
            return github.get_user((err) => {
                if(err && err.headers && err.headers['x-github-otp']) {
                    return callback(null, credentials, true);
                }

                return callback(null, credentials, false);
            });
        },
        (credentials, needs_otp, callback) => {
            if(method === 'bitbucket') {
                return callback(null, credentials);
            }

            if(needs_otp) {
                return prmpt.get([{
                    name: 'otp',
                    description: chalk.white('Authentication Code'),
                    required: true
                }], (err, res) => {
                    if(err) {
                        return callback(err);
                    }

                    return github.authorize(res.otp, callback);
                });
            } else{
                return github.authorize(null, callback);
            }
        }
    ], (err, auth) => {
        if(err) {
            let err_msg = err.message || 'There was an error logging in!';

            if(err.code === 401) {
                if(err.message.indexOf('Must specify two-factor authentication OTP code.') > 0) {
                    err_msg = 'The OTP code provided was not valid!';
                } else{
                    err_msg = 'Invalid username or password!';
                }
            }

            return console.error(err_msg);
        }

        const request_options = {
            url: `${constants.environment.AUTH_API_BASE_URL}/v1/authenticate/${method}/authorization`,
            method: 'POST'
        };

        if(method === 'github') {
            request_options.json = {
                authorization: auth.token
            };
        } else if(method === 'bitbucket') {
            request_options.json = auth;
        }

        return request(request_options, (err, response) => {
            if(err || response.statusCode != 201) {
                return console.error('Failed to log in!');
            }

            const conf = configuration.get();
            conf.plugins.cloud.config = conf.plugins.cloud.config || {};
            conf.plugins.cloud.config.token = response.body.token;
            conf.metadata = conf.metadata || {};
            conf.metadata.request = conf.metadata.request || {};
            conf.metadata.request.headers = conf.metadata.request.headers || {};
            conf.metadata.request.headers.authorization = `Bearer ${response.body.token}`;
            configuration.set(conf);

            return console.info('Successfully logged in to Containership Cloud!');
        });
    });
}

module.exports.commands.push({
    name: 'account',
    description: 'Show and manipulate cloud account.',
    commands: [
        {
            name: 'login',
            description: 'Login commands for cloud services.',
            commands: [
                {
                    name: 'github',
                    description: 'Login with github.',
                    callback: () => {
                        return login('github');
                    }
                },
                {
                    name: 'bitbucket',
                    description: 'Login with bitbucket.',
                    callback: () => {
                        return login('bitbucket');
                    }
                }
            ]
        },
        {
            name: 'logout',
            description: 'Logout of the cloud service.',
            callback: () => {
                // clear cloud token
                const conf = configuration.get();
                delete conf.metadata.request.headers.authorization;
                configuration.set(conf);

                return console.info('Successfully logged out!');
            }
        },
        {
            name: 'info',
            description: 'Show information about logged in cloud account.',
            callback: () => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');

                if(!token) {
                    return console.error('You must be logged in to view account info!');
                }

                let request_options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/account`,
                    method: 'GET',
                    json: true,
                    headers: {
                        'authorization': `Bearer ${token}`
                    }
                };

                return request(request_options, function(err, response) {
                    if(err || response.statusCode != 200) {
                        return console.error('Could not fetch account info!');
                    }

                    const headers = [
                        'ID',
                        'EMAIL',
                        'ORGANIZATIONS',
                        'SIGNUP_METHOD',
                        'NAME',
                        'PHONE',
                        'METADATA'
                    ];

                    const account = response.body;

                    const data = [
                        account.id,
                        account.email,
                        account.organizations.map(org => {
                            return`${chalk.gray(org.name)}: ${org.id}`;
                        }).join('\n'),
                        account.signup_method,
                        account.name,
                        account.phone,
                        _.map(flatten(account.metadata || {}), (v, k) => {
                            return`${chalk.gray(k)}: ${v}`;
                        }).join('\n')
                    ];

                    const output = Table.createVerticalTable(headers, [data]);
                    return console.info(output);
                });
            }
        },
        {
            name: 'edit',
            description: 'Edit account information for user in Containership cloud.',
            options: {
                phone: {
                    description: 'Phone number for user account.',
                    type: 'string',
                    alias: 'p'
                },
                name: {
                    description: 'Name number for user account.',
                    type: 'string',
                    alias: 'n'
                },
                email: {
                    description: 'Email for user account.',
                    type: 'string',
                    alias: 'e'
                },
                metadata: {
                    description: 'Metadata keys to be updated on the user account',
                    type: 'string',
                    array: true,
                    alias: 'm',
                    default: []
                }
            },
            callback: (argv) => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');

                if(!token) {
                    return console.error('You must be logged in to edit account info!');
                }

                if(!argv.name && !argv.phone && !argv.email && !argv.metadata.length) {
                    return console.error('You must provide either name, email, or phone as a flag to edit');
                }

                let options = _.omit(argv, ['h', 'help', '$0', '_']);

                options.metadata = _.reduce(options.metadata, (acc, value) => {
                    value = value.split('=');
                    acc[value[0]] = value.length == 2 ? value[1] : null;
                    return acc;
                }, {});

                let request_options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/account`,
                    method: 'PUT',
                    json: true,
                    body: options,
                    headers: {
                        'authorization': `Bearer ${token}`
                    }
                };

                return request(request_options, function(err, response) {
                    if(err) {
                        return console.error('There was an error updating account info!');
                    }

                    if(response.statusCode !== 200) {
                        return console.error('There was an error updating account info!');
                    }

                    return console.info('Successfully updated account info!');
                });
            }
        }
    ]
});

function getOrganization(id, token, callback) {
    if(!token) {
        return callback('You must be logged in to list organizations!');
    }

    const request_options = {
        url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${id}`,
        method: 'GET',
        json: true,
        headers: {
            'authorization': `Bearer ${token}`
        }
    };

    return request(request_options, function(err, response) {
        if(err || response.statusCode != 200) {
            return callback('You do not have permissions to use this organization!');
        }

        return callback(null, response.body);
    });
}

module.exports.commands.push({
    name: 'org',
    description: 'Cloud organization commands.',
    commands: [
        {
            name: 'list',
            description: 'List available organizations.',
            callback: () => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');

                if(!token) {
                    return console.error('You must be logged in to list organizations!');
                }

                const request_options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/account`,
                    method: 'GET',
                    json: true,
                    headers: {
                        'authorization': `Bearer ${token}`
                    }
                };

                return request(request_options, function(err, response) {
                    if(err || response.statusCode !== 200) {
                        return console.error('Could not fetch organizations!');
                    }

                    const headers = ['ID', 'ORGANIZATION'];
                    const data = response.body.organizations.map(org => [org.id, org.name]);
                    const output = Table.createTable(headers, data);

                    return console.info(output);
                });
            }
        },
        {
            name: 'edit <org_id>',
            description: 'Edit Containership cloud organization',
            options: {
                name: {
                    description: 'Name of the organization.',
                    alias: 'n',
                    type: 'string'
                }
            },
            callback: (argv) => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');

                if(!token) {
                    return console.error('You must be logged in to edit a organization!');
                }

                let options = _.omit(argv, ['h', 'help', '$0', '_']);

                if(options.name === undefined) {
                    return console.error('You must specify a flag for what is being edited on the organization. See command help for more details.');
                }

                options.organization_name = options.name;
                delete options.name;

                const request_options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${argv.org_id}`,
                    method: 'PUT',
                    json: true,
                    body: options,
                    headers: {
                        'authorization': `Bearer ${token}`
                    }
                };

                return request(request_options, function(err, response) {
                    if(err) {
                        return console.error('There was an error updating the organization!');
                    }

                    if(response.statusCode === 404) {
                        return console.error('The organization id specified does not exist!');
                    }

                    if(response.statusCode !== 200) {
                        return console.error('There was an error updating the organization!');
                    }

                    return console.info('Successfully updated the organization!');
                });
            }
        },
        {
            name: 'use <org_id>',
            description: 'Set organization as active org.',
            callback: (args) => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');

                if(!token) {
                    return console.error('You must be logged in to list organizations!');
                }

                return getOrganization(args.org_id, token, (err, org) => {
                    if(err) {
                        return console.error(err);
                    }

                    const owner = _.find(org.users, { id: org.owner });

                    const headers = [
                        'ID',
                        'ORGANIZATION',
                        'OWNER',
                        'TIER'
                    ];

                    const data = [
                        org.id,
                        org.name,
                        owner.display_name,
                        org.billing.tier
                    ];

                    conf.plugins.cloud.config = conf.plugins.cloud.config || {};
                    conf.plugins.cloud.config.active_organization = org.id;
                    configuration.set(conf);

                    const output = Table.createVerticalTable(headers, [data]);

                    console.info(output);
                    return console.info(`Successfully switched to ${org.id} organization!`);
                });
            }
        },
        {
            name: 'show <org_id>',
            description: 'Show organization details.',
            callback: (args) => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');

                if(!token) {
                    return console.error('You must be logged in to list organizations!');
                }

                return getOrganization(args.org_id, token, (err, org) => {
                    if(err) {
                        return console.error(err);
                    }

                    const owner = _.find(org.users, { id: org.owner });

                    const headers = [
                        'ID',
                        'ORGANIZATION',
                        'OWNER',
                        'TIER',
                        'CREATED_AT',
                        'TEAMS'
                    ];

                    const teams = org.teams.map((team) => {
                        return`${chalk.gray(team.name)}: ${team.description}`;
                    });

                    const data = [
                        org.id,
                        org.name,
                        owner.display_name,
                        org.billing.tier,
                        org.created_at,
                        teams.join('\n')
                    ];

                    const output = Table.createVerticalTable(headers, [data]);

                    return console.info(output);
                });
            }
        }
    ]
});

function getCluster(org_id, cluster_id, token, callback) {
    if(!token) {
        return callback('You must be logged in to list clusters!');
    }

    let request_options = {
        url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${org_id}/clusters/${cluster_id}`,
        method: 'GET',
        json: true,
        headers: {
            'authorization': `Bearer ${token}`
        }
    };

    return request(request_options, function(err, response) {
        if(err || response.statusCode !== 200) {
            return callback('You do not have permissions to use this cluster!');
        }

        return callback(null, response.body);
    });
}

module.exports.commands.push({
    name: 'cluster',
    description: 'Cloud cluster commands.',
    commands: [
        {
            name: 'list',
            description: 'List available clusters for active org.',
            callback: (argv) => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');
                const org_id = _.get(conf, 'plugins.cloud.config.active_organization');

                if(!token) {
                    return console.error('You must be logged in to list organizations!');
                }

                if(!org_id) {
                    return console.error(`You must have an active_organization to edit a cluster. See '${argv.$0} cloud organization use <org_id>'.`);
                }

                const request_options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${org_id}/clusters`,
                    method: 'GET',
                    json: true,
                    headers: {
                        'authorization': `Bearer ${token}`
                    }
                };

                return request(request_options, function(err, response) {
                    if(err || response.statusCode !== 200) {
                        return console.error('Could not fetch organizations!');
                    }

                    const headers = [
                        'ID',
                        'NAME',
                        'ENVIRONMENT',
                        'CLOUD_PROVIDER',
                        'HOST_COUNT',
                        'APP_COUNT'
                    ];

                    const data = response.body.map(cluster => {
                        return[
                            cluster.id,
                            cluster.name || '',
                            cluster.environment || '',
                            cluster.provider_name || '',
                            _.keys(cluster.hosts).length,
                            _.keys(cluster.applications).length
                        ];
                    });

                    const output = Table.createTable(headers, data);

                    return console.info(output);
                });
            }
        },
        {
            name: 'edit <cluster_id>',
            description: 'Edit Containership cloud cluster',
            options: {
                locked: {
                    description: 'Whether or not the cluster is locked from modifications.',
                    alias: 'l',
                    type: 'boolean',
                    default: undefined
                }
            },
            callback: (argv) => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');
                const org_id = _.get(conf, 'plugins.cloud.config.active_organization');

                if(!token) {
                    return console.error('You must be logged in to edit a cluster!');
                }

                if(!org_id) {
                    return console.error(`You must have an active_organization to edit a cluster. See '${argv.$0} cloud organization use <org_id>'.`);
                }

                let options = _.omit(argv, ['h', 'help', '$0', '_']);

                if(options.locked === undefined) {
                    return console.error('You must specify a flag for what is being edited on the cluster. See command help for more details.');
                }

                const request_options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${org_id}/clusters/${argv.cluster_id}`,
                    method: 'PUT',
                    json: true,
                    body: options,
                    headers: {
                        'authorization': `Bearer ${token}`
                    }
                };

                return request(request_options, function(err, response) {
                    if(err) {
                        return console.error('There was an error updating the cluster!');
                    }

                    if(response.statusCode === 404) {
                        return console.error('The cluster id specified does not exist!');
                    }

                    if(response.statusCode !== 200) {
                        return console.error('There was an error updating the cluster!');
                    }

                    return console.info('Successfully updated the cluster!');
                });
            }
        },
        {
            name: 'delete <cluster_id>',
            description: 'Delete Containership cloud cluster.',
            callback: (argv) => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');
                const org_id = _.get(conf, 'plugins.cloud.config.active_organization');

                if(!token) {
                    return console.error('You must be logged in to edit a cluster!');
                }

                if(!org_id) {
                    return console.error(`You must have an active_organization to edit a cluster. See '${argv.$0} cloud organization use <org_id>'.`);
                }

                const request_options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${org_id}/clusters/${argv.cluster_id}`,
                    method: 'DELETE',
                    json: true,
                    headers: {
                        'authorization': `Bearer ${token}`
                    }
                };

                return request(request_options, function(err, response) {
                    if(err) {
                        return console.error('There was an error deleting the cluster!');
                    }

                    if(response.statusCode === 404) {
                        return console.error('The cluster id specified does not exist!');
                    }

                    if(response.statusCode !== 200) {
                        return console.error('There was an error deleting the cluster!');
                    }

                    return console.info('Successfully deleted the cluster!');
                });
            }
        },
        {
            name: 'use <cluster_id>',
            description: 'Use cluster as active cluster.',
            callback: (argv) => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');
                const org_id = _.get(conf, 'plugins.cloud.config.active_organization');

                if(!token) {
                    return console.error('You must be logged in to use a cluster!');
                }

                if(!org_id) {
                    return console.error(`You must have an active_organization to edit a cluster. See '${argv.$0} cloud organization use <org_id>'.`);
                }

                return getCluster(org_id, argv.cluster_id, token, (err, cluster) => {
                    if(err) {
                        return console.error(err);
                    }

                    conf.remotes = conf.remotes || {};
                    conf.remotes[cluster.id] = {
                        'url': `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${org_id}/clusters/${cluster.id}/proxy`,
                        'version': cluster.api_version
                    };
                    conf.metadata.active_remote = cluster.id;
                    configuration.set(conf);

                    const headers = [
                        'ID',
                        'NAME',
                        'ENVIRONMENT',
                        'CLOUD_PROVIDER',
                        'HOST_COUNT',
                        'APP_COUNT'
                    ];

                    const data = [
                        cluster.id,
                        cluster.name || '',
                        cluster.environment || '',
                        cluster.provider_name || '',
                        _.keys(cluster.hosts).length,
                        _.keys(cluster.applications).length
                    ];

                    const output = Table.createVerticalTable(headers, [data]);

                    console.info(output);
                    return console.info(`Successfully switched to use cluster: ${cluster.id}`);
                });
            }
        },
        {
            name: 'show <cluster_id>',
            description: 'Show cluster details.',
            callback: (argv) => {
                const conf = configuration.get();
                const token = _.get(conf, 'plugins.cloud.config.token');
                const org_id = _.get(conf, 'plugins.cloud.config.active_organization');

                if(!token) {
                    return console.error('You must be logged in to list organizations!');
                }

                if(!org_id) {
                    return console.error(`You must have an active_organization to edit a cluster. See '${argv.$0} cloud organization use <org_id>'.`);
                }

                return getCluster(org_id, argv.cluster_id, token, (err, cluster) => {
                    if(err) {
                        return console.error(err);
                    }

                    const headers = [
                        'ID',
                        'NAME',
                        'ENVIRONMENT',
                        'CREATED_AT',
                        'CLOUD_PROVIDER',
                        'PUBLIC_IP',
                        'PORT',
                        'LOCKED',
                        'LEADER_COUNT',
                        'FOLLOWER_COUNT',
                        'APP_COUNT',
                        'TOTAL CPUS',
                        'TOTAL MEMORY'
                    ];

                    const cpus = _.reduce(cluster.hosts, (acc, host) => {
                        if(host.mode !== 'follower') {
                            return acc;
                        }

                        return acc + parseFloat(host.cpus);
                    }, 0);

                    const memory = _.reduce(cluster.hosts, (acc, host) => {
                        if(host.mode !== 'follower') {
                            return acc;
                        }

                        return acc + parseInt(host.memory);
                    }, 0);

                    const data = [
                        cluster.id,
                        cluster.name,
                        cluster.environment,
                        cluster.created_at,
                        cluster.provider_name,
                        cluster.ipaddress,
                        cluster.port,
                        cluster.locked,
                        _.filter(cluster.hosts, { mode: 'follower' }).length,
                        _.filter(cluster.hosts, { mode: 'leader' }).length,
                        _.keys(cluster.applications).length,
                        cpus.toFixed(2),
                        `${parseInt(memory / (1024*1024))} MB`
                    ];

                    const output = Table.createVerticalTable(headers, [data]);

                    return console.info(output);
                });
            }
        }
    ]
});
