let fs = require('fs');
let {spawnSync: spawn, execSync: exec} = require('child_process');
let _ = require('lodash');
let moment = require('moment');
let prompt = require('syncoprompt');
let args = require('yargs')
    .usage('Usage: $0 [-t target] <command> [args...]')
    .version(global.APPVERSION)
    .command('build [branch...]', 'Build the latest version of a given branch')
    .command('rebuild', 'Re-run the build scripts for the current release without updating branches')
    .command('update', 'Update and rebuild release branches in-place (keep in mind that this is not two-step)')
    .command('link <release>', 'Change the production links to point to the build locations for a given release')
    .command('deploy [branch...]', 'Perform a "build" and "link", in that order, deploying the latest version of a given branch in a two-step fashion')
    .command('rollback', 'Rollback to the release before the current one')
    .command('list', 'List current releases with their respective branches')
    .command('prune [prunespec]', 'Prune old releases. <prunespec> can be a number of releases to keep (default: 10), or "all" to prune all but the currently linked release.')
    .demand(1)
    .option('t', {
        alias: 'target',
        default: null,
        type: 'string',
        describe: 'A target production environment to work with (eg. prod). If empty, the configured default will be assumed'
    })
    .option('n', {
        alias: 'no-hooks',
        default: false,
        type: 'boolean',
        describe: 'Disable running of post-deploy/link hook(s)'
    })
    .option('c', {
        alias: 'no-copy',
        default: false,
        type: 'boolean',
        describe: 'Ignore configured module copy dirs and let build scripts build them from scratch'
    })
    .option('configure', {
        default: false,
        skipValidation: true,
        type: 'boolean',
        describe: 'Copy the example configuration to your home directory'
    })
    .help('help')
    .alias('h', 'help')
    .argv;

module.exports = class DeployerApp {
    constructor(config) {
        // fs.existsSync polyfill, as it has been deprecated since node v1.0.0
        if(!_.has(fs, 'existsSync')) {
            let existsSync = function(path) {
                try {
                    this.accessSync(path, this.F_OK);
                    return true;
                } catch(e) {
                    return false;
                }
            };
            fs.existsSync = existsSync.bind(fs);
        }

        // Configuration
        let homeDir = _.get(process.env, 'HOME', '');
        let homeCfgName = '.dployr_conf.js';

        // Config copy
        if(args.configure) {
            let exampleCfg = `${__dirname}/../config/config.example.js`;

            if(homeDir.length) {
                spawn('cp', ['-f', exampleCfg, `${homeDir}/${homeCfgName}`], {
                    stdio: [null, this.logOut, this.logErr]
                });
                console.log('Configuration complete');
                process.exit(0);
            } else {
                console.error('Could not get user home directory');
                process.exit(1);
            }
        }

        // Config loading
        this.config = config || this.getConfig({ homeCfgName });

        if(this.config === false) {
            console.error(`No config file found (~/${homeCfgName}). To copy the example config file, you can run:`);
            console.error("\n" + `$ ${args['$0']} --configure`);
            process.exit(1);
        }

        this.logOut = process.stdout;
        this.logErr = process.stderr;

        this.sigIntLocked = false;
        this.sigIntSent = false;
        process.on('SIGINT', this.handleSigInt);
    }

    getConfig(cfgOpts = { homeCfgName: '.dployr_conf.js' }) {
        let configFile = null;

        // User-level config
        let homeDir = _.get(process.env, 'HOME', '');
        let homeCfg = `${homeDir}/${cfgOpts.homeCfgName}`;
        if(homeDir.length && fs.existsSync(homeCfg)) {
            configFile = homeCfg;
        }

        // Global-level config (not-recommended)
        let globalCfg = `${__dirname}/../config/config.js`;
        if(fs.existsSync(globalCfg)) {
            configFile = globalCfg;
        }

        if(!configFile) {
            return false;
        } else {
            let config = {};
            try {
                config = require(configFile);
            } catch(e) {
                console.error('Could not load config file. It likely contains errors.');
                process.exit(1);
            }

            return config;
        }
    }

    handleSigInt() {
        this.sigIntSent = true;

        if(!this.sigIntLocked) {
            this.sigIntExit();
        }
    }

    sigIntExit() {
        console.log('Caught interrupt signal. Exiting...');
        process.exit(0);
    }

    lockSigInt() {
        this.sigIntLocked = true;
    }

    unlockSigInt() {
        this.sigIntLocked = false;

        if(this.sigIntSent) {
            this.sigIntExit();
        }
    }

    parseOpts() {
        this.command = _.first(args._);
        this.target = args.t || this.config.defaultTarget || 'prod';
        this.tconf = _.get(this.config, 'targets.' + this.target, {});
        this.repos = _.get(this.tconf, 'repos', {});
    }

    getRefHash(refSpec, repoDir) {
        if(refSpec.search(/\/|origin/) === -1 && refSpec.length !== 40) {
            refSpec = `origin/${refSpec}`;
        }

        let ret = spawn('git', ['rev-parse', refSpec], {
            cwd: repoDir,
            encoding: 'utf8'
        });

        return ret.stdout.trim();
    }

    readRepoConfig(configFile) {
        let cfg = {
            currentRelease: '',
            currentBranch: ''
        };

        try {
            if(fs.existsSync(configFile)) {
                let fileCfg = fs.readFileSync(configFile);
                fileCfg = JSON.parse(fileCfg);
                cfg = _.merge(cfg, fileCfg);
            }
        } catch(e) {}

        return cfg;
    }

    writeRepoConfig(configFile, config = {}) {
        try {
            let cfgStr = JSON.stringify(config, null, '    ');
            fs.writeFileSync(configFile, cfgStr);

            return true;
        } catch(e) {}

        return false;
    }

    getReleaseName() {
        return moment().format('YYYYMMDDHHmmss');
    }

    getPreviousReleaseName(releaseDir, currentRelease) {
        let releaseDirs = fs.readdirSync(releaseDir);
        let releaseIdx = releaseDirs.indexOf(currentRelease);
        let previousRelease = releaseIdx !== -1 ? releaseDirs[releaseIdx > 0 ? releaseIdx - 1 : releaseIdx] : null;

        return previousRelease;
    }

    getReleaseNames(releaseDir) {
        return fs.readdirSync(releaseDir);
    }

    run() {
        let baseDir = _.get(this.config, 'baseDir', '/Prod');

        if(!fs.existsSync(baseDir)) {
            console.error(`Cannot find base directory (${baseDir}). Please create or mount it first!`);
            process.exit(1);
        }

        if(_.indexOf([
            'build',
            'rebuild',
            'update',
            'link',
            'deploy',
            'rollback',
            'list',
            'prune'
        ], this.command) == -1) {
            console.error(`Invalid command '${this.command}'`);
            process.exit(1);
        }
        if(!_.has(this.tconf, 'repos')) {
            console.error('No target configurations in config file')
            process.exit(1)
        }

        let infoDir = baseDir + '/' + _.get(this.config, 'infoDir', 'info') + '/' + this.target;
        let linkDir = baseDir + '/' + _.get(this.config, 'linkDir', 'links') + '/' + this.target;
        let releaseDir = baseDir + '/' + _.get(this.config, 'releaseDir', 'releases') + '/' + this.target;
        let hookDir = baseDir + '/' + _.get(this.config, 'hookDir', 'hooks') + '/' + this.target;
        let releaseName = this.getReleaseName();

        _.each([infoDir, linkDir, releaseDir, hookDir], (dir) => {
            if(!fs.existsSync(dir)) {
                spawn('mkdir', ['-p', dir], {stdio: [null, this.logOut, this.logErr]});
            }
        });

        let deployInfo = {};

        // Step 1 - Build
        if(this.command == 'build' || this.command == 'deploy') {
            let branches = null;
            if(_.has(args, 'branch') && _.size(args.branch) > 0) {
                branches = args.branch;
            }

            _.each(this.tconf.repos, (rconf, repo) => {
                let repoDir = baseDir + '/' + _.get(this.config, 'repoDir', 'repos') + '/' + repo;
                let repoCfg = this.readRepoConfig(`${infoDir}/${repo}.json`);
                let branch = _.first(branches);

                // Setup and maintenance
                if(!fs.existsSync(repoDir + '/.git')) {
                    console.log(`Cloning repository '${repo}' into ${repoDir}...`);

                    spawn('mkdir', ['-p', repoDir], {stdio: [null, this.logOut, this.logErr]});
                    spawn('git', ['clone', rconf.origin, '.'], {
                        cwd: repoDir,
                        stdio: [null, this.logOut, this.logErr]
                    });
                } else {
                    console.log(`Updating repository '${repo}'...`);

                    spawn('git', ['pull'], {
                        cwd: repoDir,
                        stdio: [null, this.logOut, this.logErr]
                    });
                }

                console.log("Pruning remote 'origin'...");
                spawn('git', ['remote', 'prune', 'origin'], {
                    cwd: repoDir,
                    stdio: [null, this.logOut, this.logErr]
                });

                // Build
                if(branch === undefined) {
                    let currentBranch = _.get(repoCfg, 'currentBranch', '');
                    if(currentBranch.length > 0) {
                        branch = currentBranch;
                    } else {
                        console.error('No branch specified and no saved branch name to use');
                        process.exit(1);
                    }
                } else if (_.size(branches) > 1) {
                    branches.shift();
                }

                let repoReleaseDir = `${releaseDir}/${releaseName}/${repo}`;

                if(!fs.existsSync(repoReleaseDir)) {
                    spawn('mkdir', ['-p', repoReleaseDir], {stdio: [null, this.logOut, this.logErr]});
                }

                console.log(`Copying repo at branch: ${branch}...`);
                spawn('git', ['checkout', '-f', branch], {
                    cwd: repoDir,
                    stdio: [null, this.logOut, this.logErr]
                });
                spawn('git', ['clone', 'file://' + repoDir, repoReleaseDir], {
                    cwd: repoDir,
                    stdio: [null, this.logOut, this.logErr]
                });
                spawn('git', ['checkout', 'master'], {
                    cwd: repoDir,
                    stdio: [null, this.logOut, this.logErr]
                });
                spawn('git', ['branch', '-d', branch], {
                    cwd: repoDir,
                    stdio: [null, this.logOut, this.logErr]
                });

                let copyModuleDirs = _.get(rconf, 'copyModuleDirs', []);
                if(!args.c && copyModuleDirs.length > 0) {
                    let curRepoDir = `${linkDir}/${repo}`;

                    console.log(`Copying production module/vendor directories...`);
                    _.each(copyModuleDirs, (modDir) => {
                        let relModDir = modDir.replace(/(^\/|\/$)/g, '');
                        let curModDir = `${curRepoDir}/${relModDir}`;

                        if(fs.existsSync(curModDir)) {
                            let newModDir = repoReleaseDir + '/' + relModDir.substring(0, relModDir.lastIndexOf('/'));
                            newModDir = newModDir.replace(/\/$/g, '');
                            spawn('cp', ['-r', '-f', curModDir, `${newModDir}`], {
                                cwd: repoReleaseDir,
                                stdio: [null, this.logOut, this.logErr]
                            });
                        }
                    });
                }

                console.log(`Building copy of repo...`);
                let buildScript = repoReleaseDir + '/' + _.get(rconf, 'buildScript', 'build.sh');
                if(fs.existsSync(buildScript)) {
                    spawn('bash', [buildScript], {stdio: [null, this.logOut, this.logErr]});
                }

                // Save branch name in repo dir
                fs.writeFileSync(`${repoReleaseDir}/_REPOBRANCH.info`, branch);
            });
        }

        if(this.command == 'update') {
            _.each(this.tconf.repos, (rconf, repo) => {
                let repoDir = baseDir + '/' + _.get(this.config, 'repoDir', 'repos') + '/' + repo;
                let repoCfg = this.readRepoConfig(`${infoDir}/${repo}.json`);
                let releaseBranch = _.get(repoCfg, 'currentBranch', null);
                releaseName = _.get(repoCfg, 'currentRelease', null);

                if(releaseName === null || releaseBranch == null) {
                    console.error('Cannot find current release information!');
                    process.exit(1);
                }

                let repoReleaseDir = `${releaseDir}/${releaseName}/${repo}`;

                console.log(`Updating repository '${repo}'...`);
                spawn('git', ['pull'], {
                    cwd: repoDir,
                    stdio: [null, this.logOut, this.logErr]
                });

                console.log(`Updating release branch ${releaseBranch}`);
                spawn('git', ['checkout', '-f', releaseBranch], {
                    cwd: repoDir,
                    stdio: [null, this.logOut, this.logErr]
                });
                spawn('git', ['pull'], {
                    cwd: repoReleaseDir,
                    stdio: [null, this.logOut, this.logErr]
                });
                spawn('git', ['checkout', 'master'], {
                    cwd: repoDir,
                    stdio: [null, this.logOut, this.logErr]
                });
                spawn('git', ['branch', '-d', releaseBranch], {
                    cwd: repoDir,
                    stdio: [null, this.logOut, this.logErr]
                });

                console.log('Rebuilding release branch...');
                let buildScript = repoReleaseDir + '/' + _.get(rconf, 'buildScript', 'build.sh');
                if(fs.existsSync(buildScript)) {
                    spawn('bash', [buildScript], {stdio: [null, this.logOut, this.logErr]});
                }

                // Branch information for hooks
                if(_.get(deployInfo, 'OLD_BRANCH', null) == null) {
                    deployInfo.OLD_BRANCH = releaseBranch;
                }
                if(_.get(deployInfo, 'NEW_BRANCH', null) == null) {
                    deployInfo.NEW_BRANCH = releaseBranch;
                }
            });
        }

        if(this.command == 'deploy') {
            let input = prompt('The release has now been built. Are you ready to swap the symlinks? ');

            if(input.length > 0 && input.indexOf('n') !== -1) {
                let cmdStr = args['$0'] + (args.t == null ? '' : ' -t ' + args.t);

                console.log('Linking skipped. When you are ready, just run:');
                console.log(`$ ${cmdStr} link ${releaseName}`);
                process.exit(1);
            }
        } else if(this.command == 'build') {
                let cmdStr = args['$0'] + (args.t == null ? '' : ' -t ' + args.t);

                console.log('Build complete. When you are ready, just run:');
                console.log(`$ ${cmdStr} link ${releaseName}`);
        }

        // Step 2 - Set symlink
        if(this.command == 'link' || this.command == 'deploy') {
            if(this.command == 'link') {
                if(_.has(args, 'release') && _.size(args.release.toString()) > 0) {
                    releaseName = args.release.toString();
                } else {
                    console.error('Command "link" requires a valid release to swap the production links');
                    process.exit(1);
                }
            }

            _.each(this.tconf.repos, (rconf, repo) => {
                let repoReleaseDir = `${releaseDir}/${releaseName}/${repo}`;
                if(!fs.existsSync(repoReleaseDir)) {
                    console.error(`Cannot find release directory at: ${repoReleaseDir}...`);
                    process.exit(1);
                }
            });

            _.each(this.tconf.repos, (rconf, repo) => {
                let repoDir = baseDir + '/' + _.get(this.config, 'repoDir', 'repos') + '/' + repo;
                let repoCfg = this.readRepoConfig(`${infoDir}/${repo}.json`);
                let linkFile = linkDir + '/' + repo;
                let repoReleaseDir = `${releaseDir}/${releaseName}/${repo}`;
                let releaseBranch = '';

                if(fs.existsSync(`${repoReleaseDir}/_REPOBRANCH.info`)) {
                    releaseBranch = fs.readFileSync(`${repoReleaseDir}/_REPOBRANCH.info`).toString().trim();
                }

                // Make sure we can't exit during symlink swap
                this.lockSigInt();

                console.log(`Linking to new release dir for '${repo}'...`);
                if(fs.existsSync(linkFile)) {
                    fs.unlinkSync(linkFile);
                }
                fs.symlinkSync(repoReleaseDir, linkFile, 'dir');

                let oldRelease = repoCfg.currentRelease;
                let oldBranch = repoCfg.currentBranch;

                repoCfg.currentRelease = releaseName;
                repoCfg.currentBranch = releaseBranch;
                this.writeRepoConfig(`${infoDir}/${repo}.json`, repoCfg);

                this.unlockSigInt();

                // Branch information for hooks
                if(_.get(deployInfo, 'OLD_BRANCH', null) == null) {
                    deployInfo.OLD_BRANCH = oldBranch;
                }
                if(_.get(deployInfo, 'NEW_BRANCH', null) == null) {
                    deployInfo.NEW_BRANCH = releaseBranch;
                }
            });
        }

        // Step 3 - Run post-deploy/post-link hooks
        if(!args.n && (this.command == 'link' || this.command == 'deploy' || this.command == 'update')) {
            let hookScripts = fs.readdirSync(hookDir);
            deployInfo.RELEASE_NAME = releaseName;
            deployInfo.DPLOYR_CMD = this.command;

            if(hookScripts.length) {
                console.log('Running hooks...');
                _.each(hookScripts, (hookScript) => {
                    let hookScriptPath = `${hookDir}/${hookScript}`;

                    if(/^hook_.*\.js/.test(hookScript)) { // Script name must begin with hook_ and end with .js
                        console.log(`Running hook '${hookScriptPath}'...`);

                        let hookScriptEnv = _.merge({}, process.env, deployInfo, {
                            'DEPLOY_HOOK': true
                        });

                        try {
                            spawn('node', [hookScriptPath], {
                                cwd: hookDir,
                                stdio: [null, this.logOut, this.logErr],
                                env: hookScriptEnv
                            });
                        } catch(e) {
                            console.error(`Error running script: ${e.message}`);
                        }
                    } else {
                        console.error(`Refusing to run mis-named '${hookScriptPath}!'`);
                    }
                });
            }
        }

        // Useful commands
        if(this.command == 'rebuild') {
            _.each(this.tconf.repos, (rconf, repo) => {
                let repoCfg = this.readRepoConfig(`${infoDir}/${repo}.json`);
                releaseName = _.get(repoCfg, 'currentRelease', null);

                if(releaseName === null) {
                    console.error('Cannot find current release!');
                    process.exit(1);
                }

                let repoReleaseDir = `${releaseDir}/${releaseName}/${repo}`;

                console.log(`Rebuilding copy of repo...`);
                let buildScript = repoReleaseDir + '/' + _.get(rconf, 'buildScript', 'build.sh');
                if(fs.existsSync(buildScript)) {
                    spawn('bash', [buildScript], {stdio: [null, this.logOut, this.logErr]});
                }
            });
        }

        if(this.command == 'rollback') {
            _.each(this.tconf.repos, (rconf, repo) => {
                let linkFile = linkDir + '/' + repo;
                let repoCfg = this.readRepoConfig(`${infoDir}/${repo}.json`);
                releaseName = _.get(repoCfg, 'currentRelease', null);

                if(releaseName === null) {
                    console.error('Cannot find current release to rollback from!');
                    process.exit(1);
                }

                let previousRelease = this.getPreviousReleaseName(releaseDir, releaseName);

                if(previousRelease === null) {
                    console.error('Cannot determine previous release!');
                    process.exit(1);
                }

                let repoReleaseDir = `${releaseDir}/${previousRelease}/${repo}`;
                let releaseBranch = '';

                if(fs.existsSync(`${repoReleaseDir}/_REPOBRANCH.info`)) {
                    releaseBranch = fs.readFileSync(`${repoReleaseDir}/_REPOBRANCH.info`).toString().trim();
                }

                this.lockSigInt();

                console.log(`Rolling back to previous release...`);
                if(fs.existsSync(linkFile)) {
                    fs.unlinkSync(linkFile);
                }
                fs.symlinkSync(repoReleaseDir, linkFile, 'dir');

                repoCfg.currentRelease = previousRelease;
                repoCfg.currentBranch = releaseBranch;
                this.writeRepoConfig(`${infoDir}/${repo}.json`, repoCfg);

                this.unlockSigInt();
            });
        }

        if(this.command == 'list') {
            let releases = this.getReleaseNames(releaseDir);
            let releaseInfo = [];

            _.each(releases, (release) => {
                let releaseBranches = '';
                let current = false;

                _.each(this.tconf.repos, (rconf, repo) => {
                    let repoReleaseDir = `${releaseDir}/${release}/${repo}`;
                    let repoCfg = this.readRepoConfig(`${infoDir}/${repo}.json`);

                    if(repoCfg.currentRelease.toString() == release.toString()) {
                        current = true;
                    }

                    if(fs.existsSync(`${repoReleaseDir}/_REPOBRANCH.info`)) {
                        releaseBranches = releaseBranches + ' ' + repo + ':' + fs.readFileSync(`${repoReleaseDir}/_REPOBRANCH.info`).toString().trim();
                    }
                });

                let currentStr = current ? '*' : ' ';
                releaseInfo.push(`${currentStr}${release} -> ${releaseBranches}`);
            });

            console.log("Current releases:\n\n" + releaseInfo.join("\n"));
        }

        if(this.command == 'prune') {
            let prunespec = _.get(args, 'prunespec', 10);
            let releases = this.getReleaseNames(releaseDir);

            _.each(this.tconf.repos, (rconf, repo) => {
                let repoCfg = this.readRepoConfig(`${infoDir}/${repo}.json`);
                let currentRelease = repoCfg.currentRelease.toString();

                _.pull(releases, currentRelease);
            });

            if(prunespec !== 'all') {
                prunespec = parseInt(prunespec);
                _.pullAll(releases, _.takeRight(releases, prunespec));
            }

            if(releases.length == 0) {
                console.log('No releases selected for removal');
                process.exit(0);
            }

            console.log(`Releases selected for removal:\n\n${(releases.join("\n"))}\n`);

            let input = prompt('Prune the above releases? ');
            if(input.length == 0 || input.indexOf('n') == -1) {
                console.log('Pruning...');

                _.each(releases, (pruneRelease) => {
                    if(releaseDir.length > 3 && pruneRelease.length > 3) {
                        let pruneReleaseDir = `${releaseDir}/${pruneRelease}`;
                        spawn('rm', ['-r', pruneReleaseDir]);
                    }
                });
            }
        }
    }
}