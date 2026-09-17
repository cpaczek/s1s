import { describe, expect, it } from 'vitest';
import { extractFacts } from '../src/index/facts.ts';
import { graphOf } from '../src/index/build.ts';
import { fakeIndex } from './fake.ts';

describe('multilingual source evidence', () => {
  it('extracts Python decorators, method calls, constants and names without docstring/comment inventions', () => {
    const f = extractFacts(`"""Create access tokens for authenticated users.
import invented
phantom()
"""
from app import crud as store
TOKEN_HEADER = "X-Session-Token"
@router.post("/login/access-token")
async def login(form: LoginForm):
    """fake_call() and import imaginary are documentation."""
    user = store.authenticate(form.username)
    return security.create_token(user.id) # shadow_call()
`, 'py');
    expect(f.about).toContain('Create access tokens');
    expect(f.decls.map(d => d.name)).toEqual(['login', 'TOKEN_HEADER']);
    expect(f.imports).toEqual([{ spec: 'app', names: ['crud'], how: 'import', typeOnly: false, line: 5 }]);
    expect(f.calls).toEqual(expect.arrayContaining(['post', 'authenticate', 'create_token', 'router.post']));
    expect(f.calls).not.toEqual(expect.arrayContaining(['phantom', 'fake_call', 'shadow_call']));
    expect(f.strings).toEqual(expect.arrayContaining(['X-Session-Token', '/login/access-token']));
  });
  it('keeps hashes inside Python strings and multiline imports with source positions', () => {
    const f = extractFacts(`from app.services import (
    authenticate as auth,
    Session,
)
ROUTE = "/login#form"
@authenticated
def handler():
    return auth()
`, 'py');
    expect(f.imports[0]).toMatchObject({ spec: 'app.services', names: ['authenticate', 'Session'], line: 1 });
    expect(f.calls).toContain('authenticated');
    expect(f.decls.find(d => d.name === 'handler')?.line).toBe(7);
  });
  it('extracts Rust public declarations, grouped imports and actual calls', () => {
    const f = extractFacts(`//! Handle signed access tokens.
use crate::auth::{verify, Claims};
pub use crate::store::Session;
mod routes;
pub async fn authenticate(token: &str) -> Claims {
    let scope = "session_created";
    tracing::info!("auth.started");
    verify(token)
}
// use crate::invented::Ghost;
`, 'rs');
    expect(f.about).toBe('Handle signed access tokens.');
    expect(f.decls).toContainEqual({ name: 'authenticate', kind: 'fn', exported: true, line: 5 });
    expect(f.imports).toEqual(expect.arrayContaining([
      { spec: 'crate::auth', names: ['verify'], how: 'import', typeOnly: false, line: 2 },
      { spec: 'crate::auth', names: ['Claims'], how: 'import', typeOnly: false, line: 2 },
      { spec: 'crate::store', names: ['Session'], how: 'reexport', typeOnly: false, line: 3 },
      { spec: 'routes', names: [], how: 'import', typeOnly: false, line: 4 },
    ]));
    expect(f.calls).toEqual(expect.arrayContaining(['verify', 'info']));
    expect(f.strings).toContain('session_created');
    expect(f.imports.some(i => i.spec.includes('invented'))).toBe(false);
  });
  it('extracts Vue scripts at original line numbers plus template component identifiers', () => {
    const f = extractFacts(`<!-- Authenticate a workspace member. -->
<template>
  <LoginForm @submit="login" />
</template>
<script setup lang="ts">
import { authenticate } from './auth';
const login = () => authenticate();
</script>
<style>.fake { content: "import phantom"; }</style>
`, 'vue');
    expect(f.about).toBe('Authenticate a workspace member.');
    expect(f.imports).toHaveLength(1);
    expect(f.imports[0]).toMatchObject({ spec: './auth', line: 6 });
    expect(f.decls).toContainEqual({ name: 'login', kind: 'const', exported: false, line: 7 });
    expect(f.calls).toEqual(expect.arrayContaining(['authenticate', 'LoginForm', 'login']));
  });
  it('does not parse commented Vue script blocks as code', () => {
    const f = extractFacts('<!-- <script>import fake from "fake"</script> -->\n<script>\nimport Real from "./real"\n</script>', 'vue');
    expect(f.imports.map(i => i.spec)).toEqual(['./real']);
  });
  it('extracts GraphQL types, operations and fields with descriptions', () => {
    const f = extractFacts(`"""Authenticate a workspace member."""
type Session {
  accessToken: String!
  viewer(id: ID!): User
}
mutation Login($email: String!) {
  login(email: $email) { accessToken }
}
# type Invented { fake: String }
`, 'graphql');
    expect(f.about).toBe('Authenticate a workspace member.');
    expect(f.decls.map(d => d.name)).toEqual(['Session', 'Login']);
    expect(f.keys).toEqual(['accessToken', 'viewer']);
  });
  it('extracts Go grouped imports, receivers and exported names', () => {
    const f = extractFacts(`// Route authentication requests.
package auth
import (
  "net/http"
  tokens "example.org/project/token"
)
type Handler struct {}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
  tokens.Validate(r.Header.Get("X-Access-Token"))
}
`, 'go');
    expect(f.imports.map(i => i.spec)).toEqual(['net/http', 'example.org/project/token']);
    expect(f.decls).toContainEqual({ name: 'ServeHTTP', kind: 'func', exported: true, line: 8 });
    expect(f.calls).toContain('Validate');
    expect(f.strings).toContain('X-Access-Token');
  });
  it('extracts Go single imports without swallowing subsequent declarations', () => {
    const f = extractFacts('package auth\nimport "net/http"\nfunc Handle() { log("auth.called") }', 'go');
    expect(f.imports.map(i => i.spec)).toEqual(['net/http']);
  });
  it('extracts Java public declarations, annotations, imports and method calls', () => {
    const f = extractFacts(`/** Authenticate API requests. */
package demo.auth;
import demo.tokens.TokenService;
@RestController
public final class LoginController {
  @PostMapping("/auth/login")
  public Session login() { return tokens.createSession(); }
}
`, 'java');
    expect(f.decls).toContainEqual({ name: 'LoginController', kind: 'class', exported: true, line: 5 });
    expect(f.imports[0]).toMatchObject({ spec: 'demo.tokens.TokenService', line: 3 });
    expect(f.calls).toEqual(expect.arrayContaining(['RestController', 'PostMapping', 'createSession']));
    expect(f.strings).toContain('/auth/login');
  });
});

describe('file-backed language references', () => {
  it('resolves from pkg import module to module implementation while preserving declared symbols', () => {
    const texts = {
      'backend/app/__init__.py': 'VERSION = "1.0.0"\n',
      'backend/app/crud.py': 'def authenticate():\n    return True\n',
      'backend/app/VERSION.py': 'VALUE = "shadow"\n',
      'backend/app/routes/login.py': 'from app import crud as store, VERSION\nstore.authenticate()\n',
    };
    const graph = graphOf(fakeIndex(Object.keys(texts), texts));
    expect(graph.out.get('backend/app/routes/login.py')?.map(e => e.to)).toEqual(['backend/app/__init__.py', 'backend/app/crud.py']);
    expect(graph.out.get('backend/app/routes/login.py')?.find(e => e.to.endsWith('crud.py'))).toMatchObject({ names: ['crud'], via: 'backend/app/__init__.py' });
  });
  it('resolves relative Python submodules with aliases and leaves missing imports unresolved', () => {
    const texts = { 'app/__init__.py': '', 'app/routes.py': 'from . import crud as store\nfrom .missing import nope', 'app/crud.py': 'def authenticate(): pass' };
    const graph = graphOf(fakeIndex(Object.keys(texts), texts));
    expect(graph.out.get('app/routes.py')?.[0].to).toBe('app/crud.py');
    expect(graph.unresolved).toContainEqual({ from: 'app/routes.py', spec: '.missing' });
  });
  it('resolves Rust crate and module references and Vue extensionless imports', () => {
    const texts = {
      'src/lib.rs': 'mod auth;', 'src/auth.rs': 'use crate::tokens::verify;\npub fn authenticate() { verify(); }',
      'src/tokens.rs': 'pub fn verify() {}', 'ui/main.ts': 'import Login from "./Login";', 'ui/Login.vue': '<script setup>\nconst ready = true;\n</script>',
    };
    const graph = graphOf(fakeIndex(Object.keys(texts), texts));
    expect(graph.out.get('src/lib.rs')?.[0].to).toBe('src/auth.rs');
    expect(graph.out.get('src/auth.rs')?.[0].to).toBe('src/tokens.rs');
    expect(graph.out.get('ui/main.ts')?.[0].to).toBe('ui/Login.vue');
  });
});
