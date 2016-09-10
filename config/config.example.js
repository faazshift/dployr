module.exports = {
    defaultTarget: 'prod',
    baseDir: '/Prod',
    releaseDir: 'releases',
    linkDir: 'current',
    repoDir: 'repos',
    infoDir: 'info',
    hookDir: 'hooks',
    targets: {
        test: {
            repos: {
                'test-repo-ui': {
                    origin: 'git@github.com:testing/test-repo-ui',
                    buildScript: 'build.sh'
                },
                'test-repo-api': {
                    origin: 'git@github.com:testing/test-repo-api',
                    buildScript: 'build.sh'
                }
            }
        },
        prod: {
            repos: {
                'test-repo-ui': {
                    origin: 'git@github.com:testing/test-repo-ui',
                    buildScript: 'build.sh',
                    copyModuleDirs: [
                        'node_modules'
                    ]
                },
                'test-repo-api': {
                    origin: 'git@github.com:testing/test-repo-api',
                    buildScript: 'build.sh',
                    copyModuleDirs: [
                        'app/vendor'
                    ]
                }
            }
        }
    }
}