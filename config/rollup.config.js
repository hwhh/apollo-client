import nodeResolve from '@rollup/plugin-node-resolve';
import { terser as minify } from 'rollup-plugin-terser';
import path from 'path';
import nodeResolve from 'rollup-plugin-node-resolve';
import invariantPlugin from 'rollup-plugin-invariant';
import fs from 'fs';

const packageJson = require('../package.json');
const entryPoints = require('./entryPoints');

const distDir = './dist';

const external = [
    'tslib',
    'ts-invariant',
    'symbol-observable',
    'graphql/language/printer',
    'optimism',
    'graphql/language/visitor',
    'graphql-tag',
    'fast-json-stable-stringify',
    '@wry/context',
    '@wry/equality',
    'prop-types',
    'hoist-non-react-statics',
    'subscriptions-transport-ws',
    'react',
    'react-native',
    'react-native-job-queue',
    'zen-observable'
];

function prepareESM(input, outputDir) {
    return {
        input,
        external,
        output: {
            dir: outputDir,
            format: 'esm',
            sourcemap: true,
        },
        // The purpose of this job is to ensure each `./dist` ESM file is run
        // through the `invariantPlugin`, with any resulting changes added
        // directly back into each ESM file. By setting `preserveModules`
        // to `true`, we're making sure Rollup doesn't attempt to create a single
        // combined ESM bundle with the final result of running this job.
        preserveModules: true,
        plugins: [
            nodeResolve(),
            invariantPlugin({
                // Instead of completely stripping InvariantError messages in
                // production, this option assigns a numeric code to the
                // production version of each error (unique to the call/throw
                // location), which makes it much easier to trace production
                // errors back to the unminified code where they were thrown,
                // where the full error string can be found. See #4519.
                errorCodes: true,
            })
        ],
    };
}
const externalPackages = new Set([
  '@wry/context',
  '@wry/equality',
  'fast-json-stable-stringify',
  'graphql-tag',
  'graphql/execution/execute',
  'graphql/language/printer',
  'graphql/language/visitor',
  'hoist-non-react-statics',
  'optimism',
  'prop-types',
  'react',
  'subscriptions-transport-ws',
  'symbol-observable',
  'ts-invariant',
  'tslib',
  'zen-observable',
]);

function prepareCJS(input, output) {
    return {
        input,
        external,
        output: {
            file: output,
            format: 'cjs',
            sourcemap: true,
            exports: 'named',
        },
        plugins: [
            nodeResolve(),
            // When generating the `dist/core/core.cjs.js` entry point (in
            // `config/prepareDist.js`), we filter and re-export the exports we
            // need from the main Apollo Client CJS bundle (to exclude React related
            // code). This means that consumers of `core.cjs.js` attempt to load the
            // full AC CJS bundle first (before filtering exports), which then means
            // the React require in the AC CJS bundle is attempted and not found
            // (since people using `core.cjs.js` want to use Apollo Client without
            // React). To address this, we make React an optional require in the CJS
            // bundle.
            (() => {
                const cjsBundle = output.replace(`${distDir}/`, '');
                return {
                    generateBundle(_option, bundle) {
                        const parts = bundle[cjsBundle].code.split(
                            /var React = require\('react'\);/);
                        // The React import should appear only once in the CJS bundle,
                        // since we build the CJS bundle using Rollup, which (hopefully!)
                        // deduplicates all external imports.
                        if (parts && parts.length === 2) {
                            bundle[cjsBundle].code = [
                                parts[0],
                                "try { var React = require('react'); } catch (error) {}",
                                parts[1],
                            ].join("\n");
                        } else {
                            throw new Error(
                                'The CJS bundle could not be prepared as a single React ' +
                                'require could not be found.'
                            );
                        }
                    }
                }
            })()
        ],
    };
  return {
    input,
    external(id) {
      return externalPackages.has(id);
    },
    output: {
      file: output,
      format: 'cjs',
      sourcemap: true,
      exports: 'named',
      externalLiveBindings: false,
    },
    plugins: [
      nodeResolve(),
    ],
  };
}

function prepareCJSMinified(input) {
    return {
        input,
        output: {
            file: input.replace('.js', '.min.js'),
            format: 'cjs',
        },
        plugins: [
            minify({
                mangle: {
                    toplevel: true,
                },
                compress: {
                    toplevel: true,
                    global_defs: {
                        '@process.env.NODE_ENV': JSON.stringify('production'),
                    },
                },
            }),
        ],
    };
}

function prepareBundle({
    dirs,
        bundleName = dirs[dirs.length - 1],
                extensions,
}) {
    const dir = path.join(distDir, ...dirs);
    return {
        input: `${dir}/index.js`,
        external(id, parentId) {
      return externalPackages.has(id) ||
        entryPoints.check(id, parentId);
    },
        output: {
            file: `${dir}/${bundleName}.cjs.js`,
            format: 'cjs',
            sourcemap: true,
            exports: 'named',externalLiveBindings: false,
        },
        plugins: [
            extensions ? nodeResolve({ extensions }) :nodeResolve(),
        ],
    };
}

export default [
        ...entryPoints.map(prepareBundle),
        // Convert the ESM entry point to a single CJS bundle.
        prepareCJS(
        './dist/index.js',
        './dist/apollo-client.cjs.js',
        ),
        // Minify that single CJS bundle.
    prepareCJSMinified(
    './dist/apollo-client.cjs.js',
  ),
];
