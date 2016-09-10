# dployr

This is a highly configurable, but simple CLI utility for managing multi-step deployment using git repositories.

## Installation

### 1. Install with NPM
```BASH
$ npm install -g dployr
```

### 2. Copy the example config file and modify it to reflect your repos and production needs
```BASH
$ dployr --configure
$ vim ~/.dployr_conf.js
```

### Done!

## Use

First you will want to make sure you have your production directory set-up and accessible by your current user. In the example config, the default production directory is `/Prod`. This can be a directory on the local filesystem, or a mount accessible by both `dployr` and the production servers.

After that, using the utility should be pretty straight forward. Say you would like to deploy the release branch `1.2.3` on both `test-repo-ui` and `test-repo-ui` (as per the example config). All you need to do is run the command:

```BASH
$ dployr deploy 1.2.3
```

That command will run the `build` step on both branches (copying the repo at the HEAD of the specified branch and running `build.sh`), then run the `link` step, linking the production symlinks for both to the specified release.

But say you would like to use different branches for each repo. Based on the example configuration, to use branch `1.2.3` of `test-repo-ui` and branch `1.2.4` of `test-repo-api`, all you need to do is run the command:

```BASH
$ dployr deploy 1.2.3 1.2.4
```

Switching back to a previous release is pretty simple as well. All you need to do is run the command:

```BASH
$ dployr rollback
```

If you would like to list all the existing releases, just run:

```BASH
$ dployr list
```

You can swap the production links to a different release at any time by using the release number:

```BASH
$ dployr link 20160910103420
```

To re-run the build scripts without touching the production links, just run:

```BASH
$ dployr rebuild
```

To pull the latest upstream updates on the current release branches, then run the build scripts again, run:

```BASH
$ dployr update
```

## Hooks

For notification purposes, you can add JavaScript hooks to the `hooks` directory. The names must begin with `hook_` and end with `.js`. Other than that, any `node`-compatible script is valid. An example script already exists in the `examples` directory of this repo.

Hooks are passed several useful environment variables. Aside from the environment of `dployr`, you have access to the following:

* `DEPLOY_HOOK`: To determine if the hook is being called from `dployr`. Should be set to `true`.
* `DPLOYR_CMD`: The command being run. One of: `deploy`, `link`, `update`.
* `RELEASE_NAME`: The numeric release name being deployed/linked.
* `OLD_BRANCH`: The branch of the first repo of the release being switched from. Not set on initial deploy.
* `NEW_BRANCH`: The branch of the first repo of the release being switched to. Can be the same as `OLD_BRANCH`.
