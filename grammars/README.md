# Bundled tree-sitter grammars

Each `.wasm` here is a tree-sitter grammar compiled to WebAssembly, shipped in
the package so a parse is a pure function of (content bytes, grammar bytes,
runtime bytes) — never of an ambient toolchain (ADR 015). A binary is added
only in the plan that makes its language judgeable, and REPLACING one is an
algo-visible event: the determinism stamp digests this directory's content
hashes, so a grammar bump re-baselines that language's anchors instead of
silently changing verdicts.

| file | grammar | provenance | ABI |
| --- | --- | --- | --- |
| `c-sharp.wasm` | tree-sitter-c-sharp (MIT) | `@vscode/tree-sitter-wasm@0.3.1` (MIT), sha256 `d12d85996c25957b4c1b71e26db2d7cc8a294997b60642e9c2a3b031b2c66dd3` | 15 |
| `go.wasm` | tree-sitter-go (MIT) | `@vscode/tree-sitter-wasm@0.3.1` (MIT), sha256 `9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7` | 15 |
| `rust.wasm` | tree-sitter-rust (MIT) | `@vscode/tree-sitter-wasm@0.3.1` (MIT), sha256 `0dac14947cb04d94466e3df659f80a4e264c216a60b3eda175eae4cf12ed7a8d` | 15 |
| `python.wasm` | tree-sitter-python (MIT) | `@vscode/tree-sitter-wasm@0.3.1` (MIT), sha256 `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` | 15 |
