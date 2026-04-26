/**
 * In-process grep and find tool overrides.
 *
 * Replaces Pi's built-in grep (spawns rg) and find (spawns fd) with pure
 * Node.js implementations that never spawn external binaries.
 *
 * WHY: On nix-darwin, all nix-store binaries are ad-hoc signed. macOS
 * syspolicyd evaluates each one, and under high spawn rates (many concurrent
 * AI agents) the evaluation queue overflows, blocking all process launches
 * for minutes. In-process tools avoid this entirely.
 *
 * Placement: ~/.pi/agent/extensions/inprocess-tools.ts
 * Survives Pi upgrades (unlike dist/ patches).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	globSync,
} from "fs";
import { resolve, relative, basename, join } from "path";

const GREP_DEFAULT_LIMIT = 100;
const FIND_DEFAULT_LIMIT = 1000;
const MAX_BYTES = 100 * 1024;
const MAX_LINE_LENGTH = 500;

const ALWAYS_IGNORE = ["**/node_modules/**", "**/.git/**"];

function truncateLine(line: string): { text: string; wasTruncated: boolean } {
	if (line.length <= MAX_LINE_LENGTH) return { text: line, wasTruncated: false };
	return {
		text: line.slice(0, MAX_LINE_LENGTH) + "…",
		wasTruncated: true,
	};
}

function truncateOutput(text: string): { content: string; truncated: boolean } {
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes <= MAX_BYTES) return { content: text, truncated: false };
	const cut = text.slice(0, MAX_BYTES);
	const lastNewline = cut.lastIndexOf("\n");
	return {
		content: lastNewline > 0 ? cut.slice(0, lastNewline) : cut,
		truncated: true,
	};
}

function loadGitignorePatterns(searchPath: string): string[] {
	const patterns = [...ALWAYS_IGNORE];
	try {
		const gitignorePath = join(searchPath, ".gitignore");
		if (existsSync(gitignorePath)) {
			const content = readFileSync(gitignorePath, "utf-8");
			for (const raw of content.split("\n")) {
				const line = raw.trim();
				if (line && !line.startsWith("#")) {
					patterns.push(line.startsWith("/") ? line.slice(1) : `**/${line}`);
				}
			}
		}
	} catch {
		// ignore
	}
	return patterns;
}

function isBinaryFile(filePath: string): boolean {
	try {
		const fd = openSync(filePath, "r");
		const buf = Buffer.alloc(512);
		const bytesRead = readSync(fd, buf, 0, 512, 0);
		closeSync(fd);
		for (let i = 0; i < bytesRead; i++) {
			if (buf[i] === 0) return true;
		}
		return false;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	// ─── GREP ────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "grep",
		label: "grep (in-process)",
		description: `Search file contents for a pattern using in-process matching. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${MAX_BYTES / 1024}KB.`,
		parameters: Type.Object({
			pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
			path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
			glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
			literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
			context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
		}),

		async execute(_toolCallId, params, signal) {
			const {
				pattern,
				path: searchDir,
				glob: globFilter,
				ignoreCase,
				literal,
				context: contextLines = 0,
				limit,
			} = params;
			const searchPath = resolve(process.cwd(), searchDir || ".");
			const effectiveLimit = Math.max(1, limit ?? GREP_DEFAULT_LIMIT);

			let regex: RegExp;
			try {
				const flags = ignoreCase ? "gi" : "g";
				const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
				regex = new RegExp(source, flags);
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `Invalid regex: ${err.message}` }],
				};
			}

			let isDir: boolean;
			try {
				isDir = statSync(searchPath).isDirectory();
			} catch {
				return {
					content: [{ type: "text" as const, text: `Path not found: ${searchPath}` }],
				};
			}

			// Single file search
			if (!isDir) {
				const content = readFileSync(searchPath, "utf-8");
				const lines = content.split("\n");
				const outputLines: string[] = [];
				let matchCount = 0;
				const name = basename(searchPath);

				for (let i = 0; i < lines.length && matchCount < effectiveLimit; i++) {
					regex.lastIndex = 0;
					if (regex.test(lines[i])) {
						matchCount++;
						const start = Math.max(0, i - contextLines);
						const end = Math.min(lines.length - 1, i + contextLines);
						for (let j = start; j <= end; j++) {
							const { text } = truncateLine(lines[j]);
							const sep = j === i ? ":" : "-";
							outputLines.push(`${name}${sep}${j + 1}${sep} ${text}`);
						}
					}
				}

				if (matchCount === 0) {
					return { content: [{ type: "text" as const, text: "No matches found" }] };
				}
				return { content: [{ type: "text" as const, text: outputLines.join("\n") }] };
			}

			// Directory search
			const ignorePatterns = loadGitignorePatterns(searchPath);
			const filePattern = globFilter || "**/*";
			let files: string[];
			try {
				files = globSync(filePattern, {
					cwd: searchPath,
					absolute: true,
					nodir: true,
					dot: true,
					ignore: ignorePatterns,
				});
			} catch {
				files = [];
			}

			const outputLines: string[] = [];
			let matchCount = 0;
			let linesTruncated = false;

			for (const filePath of files) {
				if (signal?.aborted || matchCount >= effectiveLimit) break;
				if (isBinaryFile(filePath)) continue;

				let content: string;
				try {
					content = readFileSync(filePath, "utf-8");
				} catch {
					continue;
				}

				const lines = content.split("\n");
				const relPath = relative(searchPath, filePath).replace(/\\/g, "/");

				for (let i = 0; i < lines.length && matchCount < effectiveLimit; i++) {
					regex.lastIndex = 0;
					if (regex.test(lines[i])) {
						matchCount++;
						const start = Math.max(0, i - contextLines);
						const end = Math.min(lines.length - 1, i + contextLines);
						for (let j = start; j <= end; j++) {
							const { text, wasTruncated } = truncateLine(lines[j]);
							if (wasTruncated) linesTruncated = true;
							const sep = j === i ? ":" : "-";
							outputLines.push(`${relPath}${sep}${j + 1}${sep} ${text}`);
						}
					}
				}
			}

			if (matchCount === 0) {
				return { content: [{ type: "text" as const, text: "No matches found" }] };
			}

			const raw = outputLines.join("\n");
			const { content: truncatedContent, truncated } = truncateOutput(raw);
			let output = truncatedContent;

			const notices: string[] = [];
			if (matchCount >= effectiveLimit) {
				notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
			}
			if (truncated) notices.push(`${MAX_BYTES / 1024}KB limit reached`);
			if (linesTruncated) notices.push(`Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

			return {
				content: [{ type: "text" as const, text: output }],
				details: {
					matchLimitReached: matchCount >= effectiveLimit ? effectiveLimit : undefined,
					truncation: truncated ? { truncated: true } : undefined,
					linesTruncated: linesTruncated || undefined,
				},
			};
		},
	});

	// ─── FIND ────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "find",
		label: "find (in-process)",
		description: `Search for files by glob pattern using in-process matching. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${FIND_DEFAULT_LIMIT} results or ${MAX_BYTES / 1024}KB.`,
		parameters: Type.Object({
			pattern: Type.String({
				description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
			}),
			path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
		}),

		async execute(_toolCallId, params, signal) {
			const { pattern, path: searchDir, limit } = params;
			const searchPath = resolve(process.cwd(), searchDir || ".");
			const effectiveLimit = limit ?? FIND_DEFAULT_LIMIT;

			if (!existsSync(searchPath)) {
				return {
					content: [{ type: "text" as const, text: `Path not found: ${searchPath}` }],
				};
			}

			const ignorePatterns = loadGitignorePatterns(searchPath);
			let results: string[];
			try {
				results = globSync(pattern, {
					cwd: searchPath,
					absolute: false,
					dot: true,
					ignore: ignorePatterns,
				});
			} catch {
				results = [];
			}

			if (results.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No files found matching pattern" }],
				};
			}

			const limited = results.slice(0, effectiveLimit);
			const posix = limited.map((p) => p.replace(/\\/g, "/"));
			const raw = posix.join("\n");
			const { content: truncatedContent, truncated } = truncateOutput(raw);
			let output = truncatedContent;

			const notices: string[] = [];
			if (results.length >= effectiveLimit) {
				notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
			}
			if (truncated) notices.push(`${MAX_BYTES / 1024}KB limit reached`);
			if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

			return {
				content: [{ type: "text" as const, text: output }],
				details: {
					resultLimitReached: results.length >= effectiveLimit ? effectiveLimit : undefined,
					truncation: truncated ? { truncated: true } : undefined,
				},
			};
		},
	});
}
