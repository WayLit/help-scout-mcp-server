# Contributing to Help Scout MCP Server

Thank you for your interest in contributing! This guide will help you get started.

## 🚀 Quick Start for Contributors

1. **Fork and clone the repository**
```bash
git clone https://github.com/drewburchfield/help-scout-mcp-server.git
cd help-scout-mcp-server
```

2. **Install dependencies**
```bash
pnpm install
```

3. **Set up environment**
```bash
cp .dev.vars.example .dev.vars
# Add your Help Scout + Cloudflare Access values to .dev.vars (see README.md)
```

4. **Run tests and type-check**
```bash
pnpm test
pnpm type-check
```

## 🛠️ Development Workflow

### Making Changes

1. **Create a feature branch**
```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes**
   - Write clean, documented code
   - Follow existing code patterns
   - Add tests for new functionality

3. **Test your changes**
```bash
pnpm lint         # Check code style (oxlint)
pnpm type-check   # Verify TypeScript types
pnpm test         # Run test suite (vitest)
pnpm exec wrangler deploy --dry-run  # Ensure the worker builds
```

4. **Commit and push**
```bash
git add .
git commit -m "feat: add your feature description"
git push origin feature/your-feature-name
```

5. **Create a Pull Request**

### Code Standards

- **TypeScript**: Use strict type checking
- **oxlint**: Follow the existing linting rules
- **Testing**: Add tests for new features and bug fixes
- **Documentation**: Update README and JSDoc comments as needed

### Commit Messages

We use conventional commits:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for adding tests
- `refactor:` for code refactoring

## 🧪 Testing

### Running Tests
```bash
npm test           # Run all tests
npm test -- --watch  # Watch mode
npm test -- --coverage  # With coverage
```

### Writing Tests
- Place tests in `src/__tests__/` directory
- Use descriptive test names
- Test both success and error cases
- Mock external dependencies

### Test Structure
```typescript
describe('FeatureName', () => {
  describe('methodName', () => {
    it('should do something specific', () => {
      // Test implementation
    });
  });
});
```

## 📁 Project Structure

```
src/
├── __tests__/          # Test files (vitest)
├── index.ts            # Entry: OAuthProvider wrapping the HelpScoutMCP Durable Object
├── tools.ts            # MCP tool implementations
├── resources.ts        # MCP resource handlers
├── prompts.ts          # MCP prompt templates
├── schemas.ts          # Zod schemas / types
├── helpscout-api.ts    # Per-user Help Scout API client
├── auth-handler.ts     # OAuth + Cloudflare Access auth flow
├── access-jwt.ts       # Cloudflare Access JWT verification
├── instructions.ts     # Per-user server instructions / inbox discovery
├── redaction.ts        # PII redaction (OpenRedaction)
├── audit.ts            # Optional D1 audit log
└── logger.ts           # Logging utilities
```

## 🐛 Bug Reports

When reporting bugs, please include:

1. **Clear description** of the issue
2. **Steps to reproduce** the bug
3. **Expected behavior** vs actual behavior
4. **Environment details**:
   - Node.js version
   - Operating system
   - Help Scout MCP Server version
5. **Error messages** or logs (if any)

## 💡 Feature Requests

For new features:

1. **Check existing issues** to avoid duplicates
2. **Describe the use case** and problem you're solving
3. **Provide examples** of how the feature would be used
4. **Consider backward compatibility**

## 📜 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 🙏 Thank You

Every contribution helps make this project better for the entire community!