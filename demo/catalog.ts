/** Build-time allowlist. Public callers can select these IDs, never a path or URL. */
export const REPOSITORIES = [
  { id: "opencode", name: "OpenCode", description: "An AI coding agent for building and editing software.", url: "https://github.com/anomalyco/opencode", questions: ["Where are agent tools registered?", "How are sessions persisted?", "How does the permission system work?"] },
  { id: "strapi", name: "Strapi", description: "A headless CMS that delivers your content through APIs.", url: "https://github.com/strapi/strapi", questions: ["How does authentication work?", "Where is the database connection configured?", "How are content types registered?"] },
  { id: "outline", name: "Outline", description: "A shared knowledge base for team docs and wikis.", url: "https://github.com/outline/outline", questions: ["How does authentication work?", "Where are document permissions checked?", "How does collaborative editing work?"] },
  { id: "hoppscotch", name: "Hoppscotch", description: "An API client for sending requests and testing endpoints.", url: "https://github.com/hoppscotch/hoppscotch", questions: ["How are HTTP requests sent?", "How does authentication work?", "Where are request collections stored?"] },
  { id: "ripgrep", name: "ripgrep", description: "A fast command-line tool for searching text across files.", url: "https://github.com/BurntSushi/ripgrep", questions: ["Where are command line arguments parsed?", "How are ignore files handled?", "How does parallel searching work?"] },
] as const;

export type RepositoryId = (typeof REPOSITORIES)[number]["id"];
export type Repository = { id: RepositoryId; name: string; description: string; url: string; questions: readonly string[]; revision: string; files: number; snapshotBytes: number };
export type Catalog = { repos: Repository[]; defaultRepo: RepositoryId; engineRevision: string };
