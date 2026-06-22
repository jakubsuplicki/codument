# Contributing

codument is a solo-authored, source-available project. I build and maintain it on my own, so it's both a working tool and a portfolio of how I approach change control for AI-made changes.

I'm not accepting code contributions, so please don't open a pull request. It's nothing personal; I just want to keep the codebase something I can fully stand behind.

What is very welcome:

- 🐛 Bug reports and 💡 ideas → open an issue
- 🧪 "I ran it on my repo and here's what happened" → issues or Discussions
- ⭐ a star, if it's useful to you

The Apache-2.0 license lets you fork, run, and adapt it freely for your own use.

---

## Maintainer notes

The rest of this file is for the maintainer.

### Development

```bash
git clone https://github.com/jakubsuplicki/codument.git
cd codument
npm install
npm run build
npm test
```

### Publishing a new version

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
