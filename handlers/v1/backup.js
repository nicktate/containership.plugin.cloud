'use strict';

const _ = require('lodash');

module.exports = {

    volumes: function(core, req, res, next) {
        // make sure request has backup id and data to data to persist
        if(!_.has(req.query, 'CSC_BACKUP_ID')) {
            res.stash.code = 400;
            res.stash.body = { error : 'Please include a CSC_BACKUP_ID' };
            return core.api.server.middleware.handle_response(req, res, next);
        }

        if(!_.has(req.query, 'CSC_PERSIST_DATA')) {
            res.stash.code = 400;
            res.stash.body = { error : 'Please include a CSC_PERSIST_DATA' };
            return core.api.server.middleware.handle_response(req, res, next);
        }

        if(req.query.CSC_PERSIST_DATA === 'false') {
            res.stash.code = 200;
            return next();
        }

        const current_node = core.cluster.legiond.get_attributes();
        const nodes = _.keyBy(core.cluster.legiond.get_peers(), 'id');
        nodes[current_node.id] = current_node;

        _.forEach(res.stash.body, function(application/*, application_name */) {

            const volumes = _.filter(application.volumes, (volume) => {
                return volume.host === undefined;
            });

            if(_.isEmpty(volumes)) {
                return;
            }

            _.forEach(application.containers, (container) => {
                _.forEach(container.volumes, (volume) => {
                    const volume_to_backup = _.find(volumes, (volume_without_host) => {
                        return volume_without_host.container === volume.container;
                    });

                    if(!volume_to_backup) {
                        return;
                    }

                    if(nodes[container.host]) {
                        core.loggers['containership-cloud'].log('verbose', `Requesting volume backup for ${volume.host} in container ${container.id}`);
                        const volume_id = module.exports.get_volume_id(volume.host);
                        core.cluster.legiond.send({
                            event: 'containership-cloud.backup',
                            data: {
                                path: volume.host,
                                container_id: container.id,
                                backup_id: req.query.CSC_BACKUP_ID,
                                volume_id: volume_id
                            }
                        }, nodes[container.host]);
                    }
                });
            });
        });

        res.stash.code = 200;
        return next();
    },

    get_volume_id(host_path) {
        //gets the last part of the host path which is the volume_id
        const parts = host_path.split('/');
        return parts[parts.length - 1];
    }
};
