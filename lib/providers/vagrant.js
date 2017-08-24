'use strict';

const _ = require('lodash');
const async = require('async');
const child_process = require('child_process');
const fs = require('fs');
const request = require('request');

module.exports = {

    default_exec_opts: {
        cwd: [__dirname, '..', '..'].join('/')
    },

    validate: function(fn) {
        child_process.exec('which vagrant', this.default_exec_opts, function(err) {
            if(err) {
                return fn(new Error('Cannot find vagrant executable. Is it installed?'));
            }

            return fn();
        });
    },

    get_clusters: function(fn) {
        let self = this;
        // eslint-disable-next-line handle-callback-err
        this.status(function(err, statuses) {
            let by_status = _.defaults(_.groupBy(statuses, 'status'), {
                running: []
            });
            if(by_status.running.length > 0) {
                async.parallel({
                    id: function(fn) {
                        let request_options = {
                            url: ['http://', self.ip.base.join('.'), '.', self.ip.leader, ':8080/v1/cluster'].join(''),
                            method: 'GET',
                            json: true
                        };

                        request(request_options, function(err, response) {
                            if(err || response.statusCode !== 200) {
                                return fn(null, {});
                            } else {
                                return fn(null, response.body.id);
                            }
                        });
                    },

                    applications: function(fn) {
                        let request_options = {
                            url: ['http://', self.ip.base.join('.'), '.', self.ip.leader, ':8080/v1/applications'].join(''),
                            method: 'GET',
                            json: true
                        };

                        request(request_options, function(err, response) {
                            if(err || response.statusCode !== 200) {
                                return fn(null, {});
                            } else {
                                return fn(null, response.body);
                            }
                        });
                    },

                    hosts: function(fn) {
                        let request_options = {
                            url: ['http://', self.ip.base.join('.'), '.', self.ip.leader, ':8080/v1/hosts'].join(''),
                            method: 'GET',
                            json: true
                        };

                        request(request_options, function(err, response) {
                            if(err || response.statusCode !== 200) {
                                return fn(null, {});
                            } else {
                                return fn(null, response.body);
                            }
                        });
                    }
                // eslint-disable-next-line handle-callback-err
                }, function(err, response) {
                    return fn(null, [{
                        id: response.id,
                        environment: 'local',
                        name: '',
                        applications: response.applications,
                        hosts: response.hosts,
                        provider: 'vag',
                        port: '8080',
                        api_version: 'v1',
                        configuration: {}
                    }]);
                });
            } else {
                return fn(null, []);
            }
        });
    },

    create: function(options, fn) {
        let self = this;

        async.series([
            function(fn) {
                // eslint-disable-next-line handle-callback-err
                self.status(function(err, statuses) {
                    let matching = _.filter(statuses, { status: 'running' });
                    if(matching.length > 0) {
                        return fn(new Error('Some vagrant boxes are still running. Destroy them before creating a new cluster!'));
                    } else {
                        return fn();
                    }
                });
            },
            function(fn) {
                self.generate(options, fn);
            },
            function(fn) {
                self.up(fn);
            }
        ], fn);
    },

    status: function(fn) {
        child_process.exec('vagrant status', this.default_exec_opts, function(err, stdout/*, stderr*/) {
            if(err) {
                return fn(new Error('Could not fetch vagrant status!'));
            }

            let delimiter = '\n';
            stdout = stdout.split(delimiter);

            let statuses = _.filter(stdout, function(line) {
                return line.indexOf('leader') === 0 || line.indexOf('follower') === 0;
            });

            statuses = _.map(statuses, function(line) {
                line = _.compact(line.split(' '));
                line = _.initial(line);
                return {
                    host: _.first(line),
                    status: _.rest(line).join(' ')
                };
            });

            return fn(null, statuses);
        });
    },

    destroy: function(fn) {
        let proc = child_process.spawn('vagrant', ['destroy', '--force'], this.default_exec_opts);

        proc.stdout.on('data', function(data) {
            process.stdout.write(data);
        });

        proc.stderr.on('data', function(data) {
            process.stderr.write(data);
        });

        proc.on('error', function() {
            return fn(new Error('Unable to destroy ContainerShip cluster!'));
        });

        proc.on('close', function() {
            return fn();
        });
    },

    up: function(fn) {
        let proc = child_process.spawn('vagrant', ['up'], this.default_exec_opts);

        proc.stdout.on('data', function(data) {
            process.stdout.write(data);
        });

        proc.stderr.on('data', function(data) {
            process.stderr.write(data);
        });

        proc.on('error', function(err) {
            return fn(err);
        });

        proc.on('close', function(code) {
            let err = null;
            if(code === 0) {
                process.stdout.write('\n\n');
                process.stdout.write('ContainerShip cluster successfully spun up using Vagrant!\n\n');
                process.stdout.write('Start interacting with your cluster via API: containership configure --api-url http://192.168.10.10:8080\n');
                process.stdout.write('Start interacting with your cluster via the Navigator web-ui: http://192.168.10.10:8081\n\n');
            } else {
                err = new Error('Returned non-zero exit code!');
            }

            return fn(err);
        });
    },

    generate: function(options, fn) {
        let template = [];
        let scripts = this.template.scripts({
            plugins: options.plugins.split(','),
            version: options.version
        });

        template.push(scripts);

        template.push('Vagrant.configure(2) do |config|');

        _.times(options.leaders, function(index) {
            let vm = this.template.vm({
                type: 'leader',
                hostname: ['leader', index].join('-'),
                ip: _.flatten([this.ip.base, (this.ip.leader + index)]).join('.'),
                memory: 512
            });
            template.push(vm);
        }, this);

        _.times(options.followers, function(index) {
            let vm = this.template.vm({
                type: 'follower',
                hostname: ['follower', index].join('-'),
                ip: _.flatten([this.ip.base, (this.ip.follower + index)]).join('.'),
                memory: 1024
            });
            template.push(vm);
        }, this);

        template.push('end');

        template = _.flatten(template).join('\n');

        fs.writeFile([__dirname, '..', '..', 'Vagrantfile'].join('/'), template, fn);
    },

    template: {
        vm: function(options) {
            return [
                ['    config.vm.define "', options.hostname, '" do |host|'].join(''),
                ['        host.vm.provision "shell", inline: $', options.type].join(''),
                '        host.vm.box = "containership/base"',
                '        host.vm.box_version = "1.0.14"',
                ['        host.vm.hostname = "', options.hostname, '"'].join(''),
                ['        host.vm.network "private_network", ip: "', options.ip, '"'].join(''),
                '        host.vm.provider "virtualbox" do |vb|',
                ['            vb.name = "', options.hostname, '"'].join(''),
                ['            vb.memory = "', options.memory, '"'].join(''),
                '        end',
                '    end',
                ''
            ];
        },

        scripts: function(options) {
            let cidr_range = [_.flatten([module.exports.ip.base, '0']).join('.'), '24'].join('/');

            return [
                '$leader = <<SCRIPT',
                _.map(options.plugins, function(plugin) {
                    return ['containership plugin add', plugin].join(' ');
                }).join('\n'),
                ['containership agent --mode=leader --legiond-interface=eth1 --legiond-scope=private --log-level=debug --cidr=', cidr_range].join(''),
                'SCRIPT',
                '',
                '$follower = <<SCRIPT',
                _.map(options.plugins, function(plugin) {
                    return ['containership plugin add', plugin].join(' ');
                }).join('\n'),
                ['containership agent --mode=follower --legiond-interface=eth1 --legiond-scope=private --log-level=debug --cidr=', cidr_range].join(''),
                'SCRIPT',
                ''
            ];
        }
    },

    ip: {
        base: ['192', '168', '10'],
        leader: 10,
        follower: 100
    }
};
