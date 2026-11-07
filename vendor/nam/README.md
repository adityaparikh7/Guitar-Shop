# NAM engine (vendored)

These files run Neural Amp Modeler (`.nam`) captures in the browser. They are
copied unchanged from the engine directory of the npm package
[`neural-amp-modeler-wasm`](https://github.com/tone-3000/neural-amp-modeler-wasm)
**2.0.1** (TONE3000's WebAssembly build of
[NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore)).
The only edit is the removal of a `sourceMappingURL` comment, because the source map is not shipped.

| File               | What it is                                                     |
| ------------------ | -------------------------------------------------------------- |
| `index.js`         | Main-thread API: `NamEngine.attach(ctx)` → `createNode()`       |
| `nam-worklet.js`   | The `nam-processor` AudioWorklet, with the Emscripten glue inlined |
| `nam-engine.wasm`  | NAM core + Eigen, compiled single-threaded (no SharedArrayBuffer) |

`index.js` has no imports and finds the other two files through
`import.meta.url`, so it works as-is without a bundler. `js/amp-sim.js` imports it lazily
the first time a capture is selected.

## Updating

```bash
V=2.0.1   # new version
curl -sL "https://registry.npmjs.org/neural-amp-modeler-wasm/-/neural-amp-modeler-wasm-$V.tgz" \
  | tar -xzO package/dist/engine/index.js | sed '/^\/\/# sourceMappingURL=/d' > vendor/nam/index.js
for f in nam-worklet.js nam-engine.wasm; do
  curl -sL "https://registry.npmjs.org/neural-amp-modeler-wasm/-/neural-amp-modeler-wasm-$V.tgz" \
    | tar -xzO "package/dist/engine/$f" > "vendor/nam/$f"
done
```

Check the package CHANGELOG for changes to the `NamNode` API (`loadModel`,
`unloadModel`, `dispose`) before updating.

SHA-256 of the 2.0.1 tarball: `c121037d6be47c63d7be8a7f4902568437b632ad40a64fc2e8df23e5ece5d77f`
