#!/usr/bin/env node

var packageJson = require(`${__dirname}/package.json`);
global.APPVERSION = packageJson.version;

// Environment check
if(parseInt(process.versions.node) < 6) {
    console.error('Node version 6 or higher is required. You are running version ' + process.versions.node);
    process.exit(1);
}

var DeployerApp = require(__dirname + '/src/core');
var Deployer = new DeployerApp();
Deployer.parseOpts();
Deployer.run();