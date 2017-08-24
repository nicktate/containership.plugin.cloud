'use strict';

const constants = require('./constants');
const MyriadClient = require('./myriad');

const _ = require('lodash');
const fs = require('fs');
const semver = require('semver');

const PLUGINS_DIR = '/opt/containership/plugins';
const SSH_PATH = `${PLUGINS_DIR}/cloud`;

class SSH_Keys {
    constructor(core) {
        this.core = core;

        this.myriad_client = new MyriadClient(this.core);

        const containership_version = this.myriad_client.get_containership_version();
        if(containership_version && semver.gte(containership_version, '1.8.0-0')) {
            this.write_keys();

            // force updates ssh key on full myriad sync
            this.core.cluster.legiond.on('myriad.sync.full', () => {
                this.write_keys();
            });

            const subscriber = this.myriad_client.subscribe(constants.myriad.SSH_KEYS_REGEX);

            subscriber.on('message', (message) => {
                if(message.type === 'data') {
                    this.write_keys();
                }
            });
        } else {
            this.core.loggers['containership-cloud'].log('error', 'Plugin requires version 1.8.0 of containership or greater! Refusing to set ssh keys!');
        }
    }

    write_keys() {
        this.core.loggers['containership-cloud'].log('verbose', 'Updating ssh keys');

        this.get_keys((err, keys) => {
            if(err) {
                return this.core.loggers['containership-cloud'].log('error', `Error fetching containership cloud ssh keys: ${err.message}`);
            }

            try {
                if(!fs.existsSync(PLUGINS_DIR)) {
                    fs.mkdirSync(PLUGINS_DIR);
                }

                if(!fs.existsSync(SSH_PATH)) {
                    fs.mkdirSync(SSH_PATH);
                }

                let keyFile = '';

                _.forEach(keys, (key) => {
                    keyFile += `# ${key.user} ${key.name}\n${key.key}\n\n`;
                });

                fs.writeFile(`${SSH_PATH}/authorized_keys`, keyFile, (err) => {
                    if(err) {
                        this.core.loggers['containership-cloud'].log('error', 'Unable to write new ssh keys!');
                        this.core.loggers['containership-cloud'].log('debug', err.message);
                    } else {
                        this.core.loggers['containership-cloud'].log('verbose', 'Sucessfully wrote authorized keys!');
                    }
                });
            } catch(e) {
                return this.core.loggers['containership-cloud'].log('error', JSON.stringify(e));
            }
        });
    }

    get_keys(callback) {
        this.core.cluster.myriad.persistence.get(constants.myriad.SSH_KEYS, (err, keys) => {
            if(err) {
                return callback(err);
            } else {
                try {
                    keys = JSON.parse(keys);
                    return callback(null, keys);
                } catch(err) {
                    return callback(err);
                }
            }
        });
    }
}

module.exports = SSH_Keys;
