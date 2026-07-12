# Bundled tree-sitter grammars

Each `.wasm` here is a tree-sitter grammar compiled to WebAssembly, shipped in
the package so a parse is a pure function of (content bytes, grammar bytes,
runtime bytes) — never of an ambient toolchain (ADR 015). A binary is added
only in the plan that makes its language judgeable, and REPLACING one is an
algo-visible event: the determinism stamp digests this directory's content
hashes, so a grammar bump re-baselines that language's anchors instead of
silently changing verdicts.

Provenance is a *pinned package version*, never a loose download — every binary
below is extracted from an exact-pinned dependency in `package.json`, so the
grammar bytes are reproducible from `npm install` alone. The `sha256` is over
the vendored `.wasm`.

| file | grammar | provenance | ABI |
| --- | --- | --- | --- |
| `c-sharp.wasm` | tree-sitter-c-sharp (MIT) | `@vscode/tree-sitter-wasm@0.3.1` (MIT), sha256 `d12d85996c25957b4c1b71e26db2d7cc8a294997b60642e9c2a3b031b2c66dd3` | 15 |
| `go.wasm` | tree-sitter-go (MIT) | `@vscode/tree-sitter-wasm@0.3.1` (MIT), sha256 `9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7` | 15 |
| `java.wasm` | tree-sitter-java (MIT) | `@vscode/tree-sitter-wasm@0.3.1` (MIT), sha256 `4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4` | 14 |
| `kotlin.wasm` | tree-sitter-kotlin (MIT) | `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` (MIT), sha256 `7009d69453bc8735e438b2818a633efb21c88f99782769abba60dffedfab73f7` | 14 |
| `rust.wasm` | tree-sitter-rust (MIT) | `@vscode/tree-sitter-wasm@0.3.1` (MIT), sha256 `0dac14947cb04d94466e3df659f80a4e264c216a60b3eda175eae4cf12ed7a8d` | 15 |
| `python.wasm` | tree-sitter-python (MIT) | `@vscode/tree-sitter-wasm@0.3.1` (MIT), sha256 `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` | 15 |
