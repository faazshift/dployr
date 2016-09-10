let http = require('http');
let https = require('https');
let url = require('url');

class Test_Notifier {
    constructor() {
        this.message = this.getMessage();
        console.log('Notification message: ' + this.message);

        // Notify services
        this.notifySlack('SLACK_INCOMING_WEBHOOK_URL');
    }

    getMessage() {
        let env = process.env;

        let user = env.SUDO_USER || 'Someone';
        let oldBranch = env.OLD_BRANCH || null;
        let newBranch = env.NEW_BRANCH || null;
        let diffBranch = oldBranch != newBranch;
        let releaseName = env.RELEASE_NAME || '';

        let message = null;

        if(diffBranch) {
            message = `NEW RELEASE! ${user} just switched production from ${oldBranch} to ${newBranch}!`;
        } else {
            message = `UPDATED RELEASE! ${user} just updated production, currently on branch ${newBranch}!`;
        }

        if(releaseName.length) {
            message = `${message} Release: ${releaseName}!`;
        }

        return message;
    }

    request(opts, data) {
        let req = null;
        if(opts.protocol == 'https:') {
            req = https.request(opts);
        } else {
            req = http.request(opts);
        }

        req.write(data);
        req.end();
    }

    notifySlack(hookUrl) {
        console.log('Notifying Slack!');

        let opts = url.parse(hookUrl);
        opts.method = 'POST';
        opts.headers = {
            'Content-Type': 'application/json'
        };

        let data = JSON.stringify({
            username: 'Dployr Bot',
            text: this.message,
            icon_emoji: ':some_icon:'
        });

        this.request(opts, data);
    }
}

// Run notifier if script is called from dployr script
if(typeof(process.env.DEPLOY_HOOK) != 'undefined') {
    new Test_Notifier();
}