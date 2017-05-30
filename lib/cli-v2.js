'use strict';

module.exports = {
    name: 'cloud',
    description: 'containership cloud management client',
    commands: []
};

module.exports.commands.push({
    name: 'login',
    description: 'login commands for cloud services',
    commands: [
        {
            name: 'github',
            description: 'login with github',
            callback: (args) => {
                console.log('github login');
            }
        },
        {
            name: 'bitbucket',
            description: 'login with bitbucket',
            callback: (args) => {
                console.log('bitbucket login');
            }
        }
    ]
});
