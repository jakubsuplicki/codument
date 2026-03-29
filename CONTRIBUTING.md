# Contributing

## Development

```bash
git clone https://github.com/YOUR_USERNAME/codument.git
cd codument
npm install
npm run build
npm test
```

## Making Changes

1. Create a branch: `git checkout -b my-change`
2. Make your changes
3. Build and test: `npm run build && npm test`
4. Commit and push

## Publishing a New Version

```bash
# 1. Build and test
npm run build
npm test

# 2. Bump version (creates commit + git tag)
npm version patch   # 0.1.0 → 0.1.1 (bug fixes)
npm version minor   # 0.1.0 → 0.2.0 (new features)
npm version major   # 0.1.0 → 1.0.0 (breaking changes)

# 3. Push to GitHub with tags
git push && git push --tags

# 4. Publish to npm
npm run build
npm publish --otp=CODE
```
