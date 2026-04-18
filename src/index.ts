#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { createConnection, Socket } from 'net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';

import {
	PARAMETER_MAPPINGS,
	REVERSE_PARAMETER_MAPPINGS,
	normalizeParameters,
	convertCamelToSnakeCase,
	validatePath,
	createErrorResponse,
	isGodot44OrLater,
	type OperationParams,
} from './utils.js';

import * as fs from 'fs';
import * as path from 'path';

function findProjectRoot(startPath: string): string | null {
		// Handle if startPath is a file (like a script or scene)
		let currentDir: string;
		
		if (!fs.existsSync(startPath)) {
				return null;
		}
		
		const stats = fs.statSync(startPath);
		if (stats.isFile()) {
				currentDir = path.dirname(path.resolve(startPath));
		} else {
				currentDir = path.resolve(startPath);
		}
		
		// If it's already a project directory, return it
		if (fs.existsSync(path.join(currentDir, 'project.godot'))) {
				return currentDir;
		}
		
		// Walk up the tree looking for project.godot
		const maxDepth = 20;
		for (let i = 0; i < maxDepth; i++) {
				const projectFile = path.join(currentDir, 'project.godot');
				if (fs.existsSync(projectFile)) {
						return currentDir;
				}
				
				const parentDir = path.dirname(currentDir);
				if (parentDir === currentDir) {
						// Reached root of filesystem
						break;
				}
				currentDir = parentDir;
		}
		
		return null;
}

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE: boolean = true; // Always use GODOT DEBUG MODE

const execFileAsync = promisify(execFile);

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Interface representing a running Godot process
 */
interface GodotProcess {
	process: any;
	output: string[];
	errors: string[];
}

/**
 * Interface for server configuration
 */
interface GodotServerConfig {
	godotPath?: string;
	debugMode?: boolean;
	godotDebugMode?: boolean;
	strictPathValidation?: boolean; // New option to control path validation behavior
}

/**
 * Interface for a TCP connection to the running game
 */
interface GameConnection {
	socket: Socket | null;
	connected: boolean;
	responseBuffer: string;
	pendingResolve: ((value: any) => void) | null;
	projectPath: string | null;
}

/**
 * Main server class for the Godot MCP server
 */
class GodotServer {
	private server: Server;
	private activeProcess: GodotProcess | null = null;
	private godotPath: string | null = null;
	private operationsScriptPath: string;
	private interactionScriptPath: string;
	private validatedPaths: Map<string, boolean> = new Map();
	private strictPathValidation: boolean = false;
	private gameConnection: GameConnection = {
		socket: null,
		connected: false,
		responseBuffer: '',
		pendingResolve: null,
		projectPath: null,
	};
	private lastErrorIndex: number = 0;
	private lastLogIndex: number = 0;
	private readonly INTERACTION_PORT = 9090;
	private readonly AUTOLOAD_NAME = 'McpInteractionServer';
	 /**
	 * Resolve project path with auto-detection from any file path
	 */
	private resolveProjectPath(projectPath: string | undefined, contextPath?: string): string | null {
		// If explicit project path provided, use it
		if (projectPath) {
			const resolved = path.resolve(projectPath);
			if (fs.existsSync(path.join(resolved, 'project.godot'))) {
				return resolved;
			}
			return null;
		}
		
		// Try to auto-detect from context path (script, scene, or any file)
		if (contextPath) {
			const detected = findProjectRoot(contextPath);
			if (detected) {
				this.logDebug(`Auto-detected project root: ${detected} from ${contextPath}`);
				return detected;
			}
		}
		
		return null;
	}

	constructor(config?: GodotServerConfig) {
		// Apply configuration if provided
		let debugMode = DEBUG_MODE;
		let godotDebugMode = GODOT_DEBUG_MODE;

		if (config) {
			if (config.debugMode !== undefined) {
				debugMode = config.debugMode;
			}
			if (config.godotDebugMode !== undefined) {
				godotDebugMode = config.godotDebugMode;
			}
			if (config.strictPathValidation !== undefined) {
				this.strictPathValidation = config.strictPathValidation;
			}

			// Store and validate custom Godot path if provided
			if (config.godotPath) {
				const normalizedPath = normalize(config.godotPath);
				this.godotPath = normalizedPath;
				this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

				// Validate immediately with sync check
				if (!this.isValidGodotPathSync(this.godotPath)) {
					console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
					this.godotPath = null; // Reset to trigger auto-detection later
				}
			}
		}

		// Set the path to the operations script
		this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
		this.interactionScriptPath = join(__dirname, 'scripts', 'mcp_interaction_server.gd');
		if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);

		// Initialize the MCP server
		this.server = new Server(
			{
				name: 'godot-mcp',
				version: '0.1.0',
			},
			{
				capabilities: {
					tools: {},
				},
			}
		);

		// Set up tool handlers
		this.setupToolHandlers();

		// Error handling
		this.server.onerror = (error) => console.error('[MCP Error]', error);

		// Cleanup on exit
		process.on('SIGINT', async () => {
			await this.cleanup();
			process.exit(0);
		});
	}

	/**
	 * Log debug messages if debug mode is enabled
	 * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
	 */
	private logDebug(message: string): void {
		if (DEBUG_MODE) {
			console.error(`[DEBUG] ${message}`);
		}
	}


	/**
	 * Synchronous validation for constructor use
	 * This is a quick check that only verifies file existence, not executable validity
	 * Full validation will be performed later in detectGodotPath
	 * @param path Path to check
	 * @returns True if the path exists or is 'godot' (which might be in PATH)
	 */
	private isValidGodotPathSync(path: string): boolean {
		try {
			this.logDebug(`Quick-validating Godot path: ${path}`);
			return path === 'godot' || existsSync(path);
		} catch (error) {
			this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
			return false;
		}
	}

	/**
	 * Validate if a Godot path is valid and executable
	 */
	private async isValidGodotPath(path: string): Promise<boolean> {
		// Check cache first
		if (this.validatedPaths.has(path)) {
			return this.validatedPaths.get(path)!;
		}

		try {
			this.logDebug(`Validating Godot path: ${path}`);

			// Check if the file exists (skip for 'godot' which might be in PATH)
			if (path !== 'godot' && !existsSync(path)) {
				this.logDebug(`Path does not exist: ${path}`);
				this.validatedPaths.set(path, false);
				return false;
			}

			// Try to execute Godot with --version flag
			// Using execFileAsync with argument array to prevent command injection
			await execFileAsync(path, ['--version']);

			this.logDebug(`Valid Godot path: ${path}`);
			this.validatedPaths.set(path, true);
			return true;
		} catch (error) {
			this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
			this.validatedPaths.set(path, false);
			return false;
		}
	}

	/**
	 * Detect the Godot executable path based on the operating system
	 */
	private async detectGodotPath() {
		// If godotPath is already set and valid, use it
		if (this.godotPath && await this.isValidGodotPath(this.godotPath)) {
			this.logDebug(`Using existing Godot path: ${this.godotPath}`);
			return;
		}

		// Check environment variable next
		if (process.env.GODOT_PATH) {
			const normalizedPath = normalize(process.env.GODOT_PATH);
			this.logDebug(`Checking GODOT_PATH environment variable: ${normalizedPath}`);
			if (await this.isValidGodotPath(normalizedPath)) {
				this.godotPath = normalizedPath;
				this.logDebug(`Using Godot path from environment: ${this.godotPath}`);
				return;
			} else {
				this.logDebug(`GODOT_PATH environment variable is invalid`);
			}
		}

		// Auto-detect based on platform
		const osPlatform = process.platform;
		this.logDebug(`Auto-detecting Godot path for platform: ${osPlatform}`);

		const possiblePaths: string[] = [
			'godot', // Check if 'godot' is in PATH first
		];

		// Add platform-specific paths
		if (osPlatform === 'darwin') {
			possiblePaths.push(
				'/Applications/Godot.app/Contents/MacOS/Godot',
				'/Applications/Godot_4.app/Contents/MacOS/Godot',
				`${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
				`${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
				`${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`
			);
		} else if (osPlatform === 'win32') {
			possiblePaths.push(
				'C:\\Program Files\\Godot\\Godot.exe',
				'C:\\Program Files (x86)\\Godot\\Godot.exe',
				'C:\\Program Files\\Godot_4\\Godot.exe',
				'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
				`${process.env.USERPROFILE}\\Godot\\Godot.exe`
			);
		} else if (osPlatform === 'linux') {
			possiblePaths.push(
				'/usr/bin/godot',
				'/usr/local/bin/godot',
				'/snap/bin/godot',
				`${process.env.HOME}/.local/bin/godot`
			);
		}

		// Try each possible path
		for (const path of possiblePaths) {
			const normalizedPath = normalize(path);
			if (await this.isValidGodotPath(normalizedPath)) {
				this.godotPath = normalizedPath;
				this.logDebug(`Found Godot at: ${normalizedPath}`);
				return;
			}
		}

		// If we get here, we couldn't find Godot
		this.logDebug(`Warning: Could not find Godot in common locations for ${osPlatform}`);
		console.error(`[SERVER] Could not find Godot in common locations for ${osPlatform}`);
		console.error(`[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.`);

		if (this.strictPathValidation) {
			// In strict mode, throw an error
			throw new Error(`Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.`);
		} else {
			// Fallback to a default path in non-strict mode; this may not be valid and requires user configuration for reliability
			if (osPlatform === 'win32') {
				this.godotPath = normalize('C:\\Program Files\\Godot\\Godot.exe');
			} else if (osPlatform === 'darwin') {
				this.godotPath = normalize('/Applications/Godot.app/Contents/MacOS/Godot');
			} else {
				this.godotPath = normalize('/usr/bin/godot');
			}

			this.logDebug(`Using default path: ${this.godotPath}, but this may not work.`);
			console.error(`[SERVER] Using default path: ${this.godotPath}, but this may not work.`);
			console.error(`[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.`);
		}
	}

	/**
	 * Set a custom Godot path
	 * @param customPath Path to the Godot executable
	 * @returns True if the path is valid and was set, false otherwise
	 */
	public async setGodotPath(customPath: string): Promise<boolean> {
		if (!customPath) {
			return false;
		}

		// Normalize the path to ensure consistent format across platforms
		// (e.g., backslashes to forward slashes on Windows, resolving relative paths)
		const normalizedPath = normalize(customPath);
		if (await this.isValidGodotPath(normalizedPath)) {
			this.godotPath = normalizedPath;
			this.logDebug(`Godot path set to: ${normalizedPath}`);
			return true;
		}

		this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
		return false;
	}

	/**
	 * Inject the interaction server script into the Godot project
	 */
	private injectInteractionServer(projectPath: string): void {
		const projectFile = join(projectPath, 'project.godot');
		const destScript = join(projectPath, 'mcp_interaction_server.gd');

		// Copy the interaction script into the project
		copyFileSync(this.interactionScriptPath, destScript);
		this.logDebug(`Copied interaction server script to ${destScript}`);

		// Add autoload entry to project.godot
		let content = readFileSync(projectFile, 'utf8');

		// Check if already injected
		if (content.includes(this.AUTOLOAD_NAME)) {
			this.logDebug('Interaction server autoload already present');
			return;
		}

		const autoloadLine = `${this.AUTOLOAD_NAME}="*res://mcp_interaction_server.gd"`;

		if (content.includes('[autoload]')) {
			// Add after existing [autoload] section header
			content = content.replace('[autoload]', `[autoload]\n\n${autoloadLine}`);
		} else {
			// Add new [autoload] section at end
			content += `\n[autoload]\n\n${autoloadLine}\n`;
		}

		writeFileSync(projectFile, content, 'utf8');
		this.logDebug(`Injected ${this.AUTOLOAD_NAME} autoload into project.godot`);
	}

	/**
	 * Remove the interaction server script and autoload from the project
	 */
	private removeInteractionServer(projectPath: string): void {
		const projectFile = join(projectPath, 'project.godot');
		const destScript = join(projectPath, 'mcp_interaction_server.gd');

		// Remove autoload line from project.godot
		if (existsSync(projectFile)) {
			let content = readFileSync(projectFile, 'utf8');
			// Remove the autoload line (and any surrounding blank line)
			const autoloadLine = `${this.AUTOLOAD_NAME}="*res://mcp_interaction_server.gd"`;
			content = content.replace(new RegExp(`\\n?${autoloadLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`), '\n');
			writeFileSync(projectFile, content, 'utf8');
			this.logDebug('Removed interaction server autoload from project.godot');
		}

		// Delete the script file
		if (existsSync(destScript)) {
			unlinkSync(destScript);
			this.logDebug('Deleted interaction server script from project');
		}

		// Also clean up the .uid file if Godot created one
		const uidFile = destScript + '.uid';
		if (existsSync(uidFile)) {
			unlinkSync(uidFile);
			this.logDebug('Deleted interaction server .uid file');
		}
	}

	/**
	 * Connect to the game's TCP interaction server with retries
	 */
	private async connectToGame(projectPath: string): Promise<void> {
		this.gameConnection.projectPath = projectPath;

		// Initial delay to let the game start up
		await new Promise(resolve => setTimeout(resolve, 2000));

		const maxAttempts = 10;
		const retryDelay = 500;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (!this.activeProcess) {
				this.logDebug('Game process no longer running, aborting connection');
				return;
			}

			try {
				await new Promise<void>((resolve, reject) => {
					const socket = createConnection({ host: '127.0.0.1', port: this.INTERACTION_PORT }, () => {
						this.gameConnection.socket = socket;
						this.gameConnection.connected = true;
						this.gameConnection.responseBuffer = '';
						this.logDebug(`Connected to game interaction server (attempt ${attempt})`);
						console.error(`[SERVER] Connected to game interaction server on port ${this.INTERACTION_PORT}`);

						socket.on('data', (data: Buffer) => {
							this.gameConnection.responseBuffer += data.toString();
							// Process complete lines
							while (this.gameConnection.responseBuffer.includes('\n')) {
								const newlinePos = this.gameConnection.responseBuffer.indexOf('\n');
								const line = this.gameConnection.responseBuffer.substring(0, newlinePos).trim();
								this.gameConnection.responseBuffer = this.gameConnection.responseBuffer.substring(newlinePos + 1);
								if (line.length > 0 && this.gameConnection.pendingResolve) {
									try {
										const parsed = JSON.parse(line);
										const resolver = this.gameConnection.pendingResolve;
										this.gameConnection.pendingResolve = null;
										resolver(parsed);
									} catch (e) {
										this.logDebug(`Failed to parse game response: ${line}`);
									}
								}
							}
						});

						socket.on('close', () => {
							this.logDebug('Game interaction connection closed');
							this.gameConnection.connected = false;
							this.gameConnection.socket = null;
							if (this.gameConnection.pendingResolve) {
								this.gameConnection.pendingResolve({ error: 'Connection closed' });
								this.gameConnection.pendingResolve = null;
							}
						});

						socket.on('error', (err: Error) => {
							this.logDebug(`Game interaction socket error: ${err.message}`);
						});

						resolve();
					});

					socket.on('error', (err: Error) => {
						reject(err);
					});
				});

				// Successfully connected
				return;
			} catch (err) {
				this.logDebug(`Connection attempt ${attempt}/${maxAttempts} failed, retrying in ${retryDelay}ms...`);
				await new Promise(resolve => setTimeout(resolve, retryDelay));
			}
		}

		console.error(`[SERVER] Failed to connect to game interaction server after ${maxAttempts} attempts`);
	}

	/**
	 * Disconnect from the game interaction server
	 */
	private disconnectFromGame(): void {
		if (this.gameConnection.socket) {
			this.gameConnection.socket.destroy();
			this.gameConnection.socket = null;
		}
		this.gameConnection.connected = false;
		this.gameConnection.responseBuffer = '';
		if (this.gameConnection.pendingResolve) {
			this.gameConnection.pendingResolve({ error: 'Disconnected' });
			this.gameConnection.pendingResolve = null;
		}
	}

	/**
	 * Send a command to the running game and wait for a response
	 */
	private async sendGameCommand(command: string, params: Record<string, any> = {}, timeoutMs: number = 10000): Promise<any> {
		if (!this.gameConnection.connected || !this.gameConnection.socket) {
			throw new Error('Not connected to game interaction server. Is the game running?');
		}

		const payload = JSON.stringify({ command, params }) + '\n';

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.gameConnection.pendingResolve = null;
				reject(new Error(`Game command '${command}' timed out after ${timeoutMs / 1000}s`));
			}, timeoutMs);

			this.gameConnection.pendingResolve = (response: any) => {
				clearTimeout(timeout);
				resolve(response);
			};

			this.gameConnection.socket!.write(payload);
		});
	}

	/**
	 * Clean up resources when shutting down
	 */
	private async cleanup() {
		this.logDebug('Cleaning up resources');
		this.disconnectFromGame();
		if (this.gameConnection.projectPath) {
			this.removeInteractionServer(this.gameConnection.projectPath);
			this.gameConnection.projectPath = null;
		}
		if (this.activeProcess) {
			this.logDebug('Killing active Godot process');
			this.activeProcess.process.kill();
			this.activeProcess = null;
		}
		await this.server.close();
	}

	private async gameCommand(
		name: string,
		args: any,
		argsFn: (a: any) => Record<string, any>,
		timeoutMs?: number
	): Promise<any> {
		if (!this.activeProcess) return createErrorResponse('No active Godot process. Use run_project first.');
		if (!this.gameConnection.connected) return createErrorResponse('Not connected to game interaction server.');
		args = normalizeParameters(args || {});
		try {
			const response = await this.sendGameCommand(name, argsFn(args), timeoutMs);
			if (response.error) return createErrorResponse(`${name} failed: ${response.error}`);
			return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
		} catch (error: any) {
			return createErrorResponse(`${name} failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async headlessOp(
		operation: string,
		args: any,
		argsFn: (a: any) => { projectPath: string; params: OperationParams }
	): Promise<any> {
		args = normalizeParameters(args || {});
		const { projectPath, params } = argsFn(args);

		if (!projectPath) return createErrorResponse('projectPath is required.');
		if (!validatePath(projectPath)) return createErrorResponse('Invalid path.');

		const projectFile = join(projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${projectPath}`);

		try {
			const { stdout, stderr } = await this.executeOperation(operation, params, projectPath);
			if (stderr && stderr.includes('Failed to')) return createErrorResponse(`${operation} failed: ${stderr}`);
			return { content: [{ type: 'text', text: `${operation} succeeded.\n\nOutput: ${stdout}` }] };
		} catch (error: any) {
			return createErrorResponse(`${operation} failed: ${error?.message || 'Unknown error'}`);
		}
	}

	/**
	 * Execute a Godot operation using the operations script
	 * @param operation The operation to execute
	 * @param params The parameters for the operation
	 * @param projectPath The path to the Godot project
	 * @returns The stdout and stderr from the operation
	 */
	private async executeOperation(
		operation: string,
		params: OperationParams,
		projectPath: string
	): Promise<{ stdout: string; stderr: string }> {
		this.logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
		this.logDebug(`Original operation params: ${JSON.stringify(params)}`);

		// Convert camelCase parameters to snake_case for Godot script
		const snakeCaseParams = convertCamelToSnakeCase(params);
		this.logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);


		// Ensure godotPath is set
		if (!this.godotPath) {
			await this.detectGodotPath();
			if (!this.godotPath) {
				throw new Error('Could not find a valid Godot executable path');
			}
		}

		try {
			// Serialize the snake_case parameters to a valid JSON string
			const paramsJson = JSON.stringify(snakeCaseParams);

			// Build argument array for execFile to prevent command injection
			// Using execFile with argument arrays avoids shell interpretation entirely
			const args = [
				'--headless',
				'--path',
				projectPath,  // Safe: passed as argument, not interpolated into shell command
				'--script',
				this.operationsScriptPath,
				operation,
				paramsJson,  // Safe: passed as argument, not interpreted by shell
			];

			
			if (GODOT_DEBUG_MODE) {
				args.push('--debug-godot');
			}

			this.logDebug(`Executing: ${this.godotPath} ${args.join(' ')}`);

			const { stdout, stderr } = await execFileAsync(this.godotPath!, args);

			return { stdout: stdout ?? '', stderr: stderr ?? '' };
		} catch (error: unknown) {
			// If execFileAsync throws, it still contains stdout/stderr
			if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
				const execError = error as Error & { stdout: string; stderr: string };
				return {
					stdout: execError.stdout ?? '',
					stderr: execError.stderr ?? '',
				};
			}

			throw error;
		}
	}

	/**
	 * Get the structure of a Godot project
	 * @param projectPath Path to the Godot project
	 * @returns Object representing the project structure
	 */
	private async getProjectStructure(projectPath: string): Promise<any> {
		try {
			// Get top-level directories in the project
			const entries = readdirSync(projectPath, { withFileTypes: true });

			const structure: any = {
				scenes: [],
				scripts: [],
				assets: [],
				other: [],
			};

			for (const entry of entries) {
				if (entry.isDirectory()) {
					const dirName = entry.name.toLowerCase();

					// Skip hidden directories
					if (dirName.startsWith('.')) {
						continue;
					}

					// Count files in common directories
					if (dirName === 'scenes' || dirName.includes('scene')) {
						structure.scenes.push(entry.name);
					} else if (dirName === 'scripts' || dirName.includes('script')) {
						structure.scripts.push(entry.name);
					} else if (
						dirName === 'assets' ||
						dirName === 'textures' ||
						dirName === 'models' ||
						dirName === 'sounds' ||
						dirName === 'music'
					) {
						structure.assets.push(entry.name);
					} else {
						structure.other.push(entry.name);
					}
				}
			}

			return structure;
		} catch (error) {
			this.logDebug(`Error getting project structure: ${error}`);
			return { error: 'Failed to get project structure' };
		}
	}

	/**
	 * Find Godot projects in a directory
	 * @param directory Directory to search
	 * @param recursive Whether to search recursively
	 * @returns Array of Godot projects
	 */
	private findGodotProjects(directory: string, recursive: boolean): Array<{ path: string; name: string }> {
		const projects: Array<{ path: string; name: string }> = [];

		try {
			// Check if the directory itself is a Godot project
			const projectFile = join(directory, 'project.godot');
			if (existsSync(projectFile)) {
				projects.push({
					path: directory,
					name: basename(directory),
				});
			}

			// If not recursive, only check immediate subdirectories
			if (!recursive) {
				const entries = readdirSync(directory, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const subdir = join(directory, entry.name);
						const projectFile = join(subdir, 'project.godot');
						if (existsSync(projectFile)) {
							projects.push({
								path: subdir,
								name: entry.name,
							});
						}
					}
				}
			} else {
				// Recursive search
				const entries = readdirSync(directory, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const subdir = join(directory, entry.name);
						// Skip hidden directories
						if (entry.name.startsWith('.')) {
							continue;
						}
						// Check if this directory is a Godot project
						const projectFile = join(subdir, 'project.godot');
						if (existsSync(projectFile)) {
							projects.push({
								path: subdir,
								name: entry.name,
							});
						} else {
							// Recursively search this directory
							const subProjects = this.findGodotProjects(subdir, true);
							projects.push(...subProjects);
						}
					}
				}
			}
		} catch (error) {
			this.logDebug(`Error searching directory ${directory}: ${error}`);
		}

		return projects;
	}

	/**
	 * Set up the tool handlers for the MCP server
	 */
	private setupToolHandlers() {
		// Define available tools
	this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
		// === CORE PROJECT (8 tools) ===
		{
			name: 'launch_editor',
			description: 'Launch Godot editor for a specific project',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string', description: 'Godot project path' },
			},
			required: ['projectPath'],
			},
		},
		{
			name: 'run_project',
			description: 'Run the Godot project and capture output',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string', description: 'Godot project path' },
				scene: { type: 'string', description: 'Optional: Specific scene to run' },
			},
			required: ['projectPath'],
			},
		},
		{
			name: 'stop_project',
			description: 'Stop the currently running Godot project',
			inputSchema: { type: 'object', properties: {} },
		},
		{
			name: 'get_debug_output',
			description: 'Get the current debug output and errors',
			inputSchema: { type: 'object', properties: {} },
		},
		{
			name: 'get_godot_version',
			description: 'Get the installed Godot version',
			inputSchema: { type: 'object', properties: {} },
		},
		{
			name: 'list_projects',
			description: 'List Godot projects in a directory',
			inputSchema: {
			type: 'object',
			properties: {
				directory: { type: 'string', description: 'Directory to search' },
				recursive: { type: 'boolean', description: 'Search recursively' },
			},
			required: ['directory'],
			},
		},
		{
			name: 'get_project_info',
			description: 'Retrieve metadata about a Godot project',
			inputSchema: {
			type: 'object',
			properties: { projectPath: { type: 'string' } },
			required: ['projectPath'],
			},
		},
		{
			name: 'create_project',
			description: 'Create a new Godot project from scratch',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				projectName: { type: 'string' },
			},
			required: ['projectPath', 'projectName'],
			},
		},

		// === SCENE MANAGEMENT (4 tools) ===
		{
			name: 'manage_scene',
			description: 'Create, read, modify, or save Godot scenes',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				action: { 
				type: 'string', 
				enum: ['create', 'read', 'save', 'add_node', 'modify_node', 'remove_node', 'attach_script'],
				description: 'Action to perform on the scene'
				},
				scenePath: { type: 'string', description: 'Scene file path (relative to project)' },
				// For create
				rootNodeType: { type: 'string', description: 'Root node type (for create)' },
				// For add_node/modify_node/remove_node
				nodePath: { type: 'string', description: 'Node path within scene' },
				nodeType: { type: 'string', description: 'Node type (for add_node)' },
				nodeName: { type: 'string', description: 'Node name (for add_node)' },
				parentNodePath: { type: 'string', description: 'Parent path (for add_node)' },
				properties: { type: 'object', description: 'Properties to set (for modify_node/add_node)' },
				// For attach_script
				scriptPath: { type: 'string', description: 'Script path (for attach_script)' },
				newPath: { type: 'string', description: 'New path (for save as)' },
			},
			required: ['projectPath', 'action', 'scenePath'],
			},
		},
		{
			name: 'manage_scene_structure',
			description: 'Rename, duplicate, or move nodes within scenes',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				scenePath: { type: 'string' },
				action: { type: 'string', enum: ['rename', 'duplicate', 'move'] },
				nodePath: { type: 'string' },
				newName: { type: 'string', description: 'For rename' },
				newParentPath: { type: 'string', description: 'For move' },
			},
			required: ['projectPath', 'scenePath', 'action', 'nodePath'],
			},
		},
		{
			name: 'manage_scene_signals',
			description: 'List, add, or remove signal connections in scenes',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				scenePath: { type: 'string' },
				action: { type: 'string', enum: ['list', 'add', 'remove'] },
				signalName: { type: 'string' },
				sourcePath: { type: 'string' },
				targetPath: { type: 'string' },
				method: { type: 'string' },
			},
			required: ['projectPath', 'scenePath', 'action'],
			},
		},
		{
			name: 'export_mesh_library',
			description: 'Export a scene as a MeshLibrary resource',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				scenePath: { type: 'string', description: 'Source scene (.tscn)' },
				outputPath: { type: 'string', description: 'Output path (.res)' },
				meshItemNames: { type: 'array', items: { type: 'string' } },
			},
			required: ['projectPath', 'scenePath', 'outputPath'],
			},
		},

		// === FILE OPERATIONS (5 tools) ===
		{
			name: 'manage_file',
			description: 'Read, write, delete, or rename files in the project',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				action: { type: 'string', enum: ['read', 'write', 'delete', 'rename'] },
				filePath: { type: 'string', description: 'File path (relative to project)' },
				content: { type: 'string', description: 'Content (for write)' },
				newPath: { type: 'string', description: 'New path (for rename)' },
			},
			required: ['projectPath', 'action', 'filePath'],
			},
		},
		{
			name: 'create_directory',
			description: 'Create a directory inside a Godot project',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				directoryPath: { type: 'string' },
			},
			required: ['projectPath', 'directoryPath'],
			},
		},
		{
			name: 'list_project_files',
			description: 'List project files, optionally filtered by extension',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				extensions: { type: 'array', items: { type: 'string' } },
				subdirectory: { type: 'string' },
			},
			required: ['projectPath'],
			},
		},
		{
			name: 'create_script',
			description: 'Create a GDScript file from template or source',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				scriptPath: { type: 'string' },
				extends: { type: 'string', description: 'Base class' },
				className: { type: 'string' },
				methods: { type: 'array', items: { type: 'string' } },
				source: { type: 'string', description: 'Full source code (overrides template)' },
			},
			required: ['projectPath', 'scriptPath'],
			},
		},
		{
			name: 'manage_resource',
			description: 'Create or modify .tres/.res resource files',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				resourcePath: { type: 'string' },
				action: { type: 'string', enum: ['create', 'read', 'modify'] },
				resourceType: { type: 'string', description: 'Godot class (for create)' },
				properties: { type: 'object' },
			},
			required: ['projectPath', 'resourcePath', 'action'],
			},
		},

		// === PROJECT SETTINGS (4 tools) ===
		{
			name: 'manage_project_settings',
			description: 'Read or modify project.godot settings',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				action: { type: 'string', enum: ['read', 'modify'] },
				section: { type: 'string', description: 'For modify: section name' },
				key: { type: 'string', description: 'For modify: setting key' },
				value: { type: 'string', description: 'For modify: setting value' },
			},
			required: ['projectPath', 'action'],
			},
		},
		{
			name: 'manage_autoloads',
			description: 'List, add, or remove autoloads in a Godot project',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				action: { type: 'string', enum: ['list', 'add', 'remove'] },
				name: { type: 'string', description: 'For add/remove' },
				path: { type: 'string', description: 'Script/scene path (for add)' },
			},
			required: ['projectPath', 'action'],
			},
		},
		{
			name: 'manage_input_map',
			description: 'List, add, or remove input actions and bindings',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				action: { type: 'string', enum: ['list', 'add', 'remove'] },
				actionName: { type: 'string', description: 'Input action name' },
				key: { type: 'string', description: 'Key to bind (for add)' },
				deadzone: { type: 'number', default: 0.5 },
			},
			required: ['projectPath', 'action'],
			},
		},
		{
			name: 'manage_export_presets',
			description: 'List, add, or remove export preset configuration',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				action: { type: 'string', enum: ['list', 'add', 'remove'] },
				name: { type: 'string', description: 'Preset name' },
				platform: { type: 'string', description: 'For add: platform name' },
				runnable: { type: 'boolean', description: 'For add: is runnable' },
			},
			required: ['projectPath', 'action'],
			},
		},

		// === GAME INPUT (2 tools) ===
		{
			name: 'game_mouse_input',
			description: 'Mouse actions: click, move, drag, scroll',
			inputSchema: {
			type: 'object',
			properties: {
				action: { 
				type: 'string', 
				enum: ['click', 'move', 'drag', 'scroll'],
				description: 'Type of mouse action'
				},
				x: { type: 'number', description: 'X coordinate' },
				y: { type: 'number', description: 'Y coordinate' },
				// For click
				button: { type: 'number', description: 'Mouse button (1=left, 2=right, 3=middle)', default: 1 },
				// For drag
				toX: { type: 'number', description: 'Drag end X' },
				toY: { type: 'number', description: 'Drag end Y' },
				steps: { type: 'number', description: 'Drag steps', default: 10 },
				// For scroll
				direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], default: 'up' },
				amount: { type: 'number', default: 1 },
			},
			required: ['action', 'x', 'y'],
			},
		},
		{
			name: 'game_keyboard_input',
			description: 'Keyboard and gamepad input actions',
			inputSchema: {
			type: 'object',
			properties: {
				action: { 
				type: 'string', 
				enum: ['key_press', 'key_hold', 'key_release', 'gamepad'],
				description: 'Input action type'
				},
				// For key actions
				key: { type: 'string', description: 'Key name (e.g. "W", "Space")' },
				inputAction: { type: 'string', description: 'Godot input action name' },
				pressed: { type: 'boolean', description: 'Press state (for key_press)', default: true },
				// For gamepad
				type: { type: 'string', enum: ['button', 'axis'], description: 'Gamepad input type' },
				index: { type: 'number', description: 'Button/axis index' },
				value: { type: 'number', description: 'Value (0/1 for button, -1 to 1 for axis)' },
				device: { type: 'number', description: 'Gamepad device index', default: 0 },
			},
			required: ['action'],
			},
		},

		// === GAME STATE (3 tools) ===
		{
			name: 'game_screenshot',
			description: 'Screenshot the running game (returns base64 PNG)',
			inputSchema: { type: 'object', properties: {} },
		},
		{
			name: 'game_eval',
			description: 'Execute GDScript in the running game',
			inputSchema: {
			type: 'object',
			properties: {
				code: { type: 'string', description: 'GDScript code. Use "return" for values' },
			},
			required: ['code'],
			},
		},
		{
			name: 'game_get_info',
			description: 'Get scene tree, UI elements, performance, or logs',
			inputSchema: {
			type: 'object',
			properties: {
				type: { 
				type: 'string', 
				enum: ['scene_tree', 'ui_elements', 'performance', 'logs', 'errors', 'camera'],
				description: 'What information to retrieve'
				},
			},
			required: ['type'],
			},
		},

		// === NODE OPERATIONS (3 tools) ===
		{
			name: 'game_node_property',
			description: 'Get or set node properties',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['get', 'set'] },
				nodePath: { type: 'string' },
				property: { type: 'string' },
				value: { description: 'Value (for set)' },
				typeHint: { type: 'string', description: 'Type hint: Vector2, Vector3, Color' },
			},
			required: ['action', 'nodePath', 'property'],
			},
		},
		{
			name: 'game_node_method',
			description: 'Call methods on nodes or get node info',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['call', 'get_info', 'remove', 'reparent'] },
				nodePath: { type: 'string' },
				method: { type: 'string', description: 'For call action' },
				args: { type: 'array', description: 'Method arguments' },
				newParentPath: { type: 'string', description: 'For reparent' },
				keepGlobalTransform: { type: 'boolean', description: 'For reparent', default: true },
			},
			required: ['action', 'nodePath'],
			},
		},
		{
			name: 'game_scene_management',
			description: 'Change scenes, instantiate, or spawn nodes',
			inputSchema: {
			type: 'object',
			properties: {
				action: { 
				type: 'string', 
				enum: ['change_scene', 'instantiate', 'spawn_node', 'pause'],
				description: 'Scene management action'
				},
				scenePath: { type: 'string', description: 'For change_scene/instantiate' },
				parentPath: { type: 'string', description: 'For instantiate/spawn' },
				// For spawn_node
				type: { type: 'string', description: 'Node class (for spawn_node)' },
				name: { type: 'string', description: 'Node name (for spawn_node)' },
				properties: { type: 'object', description: 'For spawn_node' },
				// For pause
				paused: { type: 'boolean', description: 'For pause', default: true },
			},
			required: ['action'],
			},
		},

		// === SIGNALS & ANIMATION (3 tools) ===
		{
			name: 'game_signal',
			description: 'Connect, disconnect, emit, or list signals',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['connect', 'disconnect', 'emit', 'list', 'await'] },
				nodePath: { type: 'string' },
				signalName: { type: 'string' },
				// For connect/disconnect
				targetPath: { type: 'string' },
				method: { type: 'string' },
				// For emit
				args: { type: 'array' },
				// For await
				timeout: { type: 'number', description: 'Timeout seconds', default: 10 },
			},
			required: ['action', 'nodePath'],
			},
		},
		{
			name: 'game_animation',
			description: 'Control AnimationPlayer and AnimationTree',
			inputSchema: {
			type: 'object',
			properties: {
				action: { 
				type: 'string', 
				enum: ['play', 'stop', 'pause', 'seek', 'queue', 'get_list', 'set_speed', 'tree_travel', 'tree_set_param'],
				description: 'Animation action'
				},
				nodePath: { type: 'string' },
				animationName: { type: 'string', description: 'For play/queue' },
				position: { type: 'number', description: 'For seek' },
				speed: { type: 'number', description: 'For set_speed' },
				// For AnimationTree
				stateName: { type: 'string', description: 'For tree_travel' },
				paramName: { type: 'string', description: 'For tree_set_param' },
				paramValue: { description: 'For tree_set_param' },
			},
			required: ['action', 'nodePath'],
			},
		},
		{
			name: 'game_tween',
			description: 'Tween node properties or create animations',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['tween_property', 'create_animation'] },
				nodePath: { type: 'string' },
				// For tween_property
				property: { type: 'string' },
				finalValue: { description: 'Target value' },
				duration: { type: 'number', default: 1.0 },
				transType: { type: 'number', default: 0 },
				easeType: { type: 'number', default: 2 },
				// For create_animation
				animationName: { type: 'string' },
				length: { type: 'number', default: 1.0 },
				loopMode: { type: 'number', default: 0 },
				tracks: { type: 'array' },
			},
			required: ['action', 'nodePath'],
			},
		},

		// === PHYSICS & COLLISION (2 tools) ===
		{
			name: 'game_physics_query',
			description: 'Raycast, overlap, and physics queries',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['raycast', 'overlap', 'point_query', 'shape_query'] },
				from: { type: 'object', description: 'Origin point {x,y} or {x,y,z}' },
				to: { type: 'object', description: 'End point (for raycast)' },
				nodePath: { type: 'string', description: 'For overlap' },
				collisionMask: { type: 'number', default: 0xFFFFFFFF },
			},
			required: ['action'],
			},
		},
		{
			name: 'game_physics_body',
			description: 'Configure physics bodies and joints',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['configure_body', 'add_collision', 'create_joint'] },
				nodePath: { type: 'string', description: 'For configure_body' },
				// For configure_body
				gravityScale: { type: 'number' },
				mass: { type: 'number' },
				linearVelocity: { type: 'object' },
				freeze: { type: 'boolean' },
				// For add_collision
				parentPath: { type: 'string' },
				shapeType: { type: 'string', enum: ['box', 'sphere', 'capsule', 'cylinder'] },
				shapeParams: { type: 'object' },
				collisionLayer: { type: 'number' },
				collisionMask: { type: 'number' },
				// For create_joint
				jointType: { type: 'string' },
				nodeAPath: { type: 'string' },
				nodeBPath: { type: 'string' },
			},
			required: ['action'],
			},
		},

		// === AUDIO (2 tools) ===
		{
			name: 'game_audio',
			description: 'Control audio playback and bus settings',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['play', 'stop', 'pause', 'configure'] },
				nodePath: { type: 'string', description: 'AudioStreamPlayer node path' },
				stream: { type: 'string', description: 'res:// path to audio' },
				volume: { type: 'number', description: 'Volume 0-1' },
				pitch: { type: 'number' },
				bus: { type: 'string' },
				fromPosition: { type: 'number' },
			},
			required: ['action'],
			},
		},
		{
			name: 'game_audio_bus',
			description: 'Manage audio buses and effects',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['set_volume', 'mute', 'solo', 'add_effect', 'remove_effect', 'configure_effect'] },
				busName: { type: 'string', default: 'Master' },
				volume: { type: 'number' },
				mute: { type: 'boolean' },
				solo: { type: 'boolean' },
				// For effects
				effectType: { type: 'string', enum: ['reverb', 'delay', 'chorus', 'eq', 'compressor'] },
				index: { type: 'number' },
				properties: { type: 'object' },
			},
			required: ['action'],
			},
		},

		// === UI CONTROLS (2 tools) ===
		{
			name: 'game_ui_control',
			description: 'Control UI elements and interactions',
			inputSchema: {
			type: 'object',
			properties: {
				action: { 
				type: 'string', 
				enum: ['configure', 'grab_focus', 'set_text', 'get_text', 'popup', 'select_item', 'set_value'],
				description: 'UI action'
				},
				nodePath: { type: 'string' },
				// For configure
				anchorPreset: { type: 'number' },
				tooltip: { type: 'string' },
				mouseFilter: { type: 'string' },
				// For text
				text: { type: 'string' },
				// For popup
				size: { type: 'object' },
				title: { type: 'string' },
				// For select_item
				index: { type: 'number' },
				// For set_value
				value: { type: 'number' },
			},
			required: ['action', 'nodePath'],
			},
		},
		{
			name: 'game_ui_container',
			description: 'Manage UI containers and lists',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['get_items', 'add_item', 'remove_item', 'clear', 'select_tab'] },
				nodePath: { type: 'string' },
				// For add/remove
				text: { type: 'string' },
				// For select
				index: { type: 'number' },
			},
			required: ['action', 'nodePath'],
			},
		},

		// === ADVANCED FEATURES (4 tools) ===
		{
			name: 'game_rendering',
			description: 'Configure rendering and environment settings',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['get_settings', 'set_msaa', 'set_fxaa', 'set_taa', 'set_environment', 'set_camera_attributes'] },
				msaa2d: { type: 'number', enum: [0, 1, 2, 3] },
				msaa3d: { type: 'number', enum: [0, 1, 2, 3] },
				fxaa: { type: 'boolean' },
				taa: { type: 'boolean' },
				// Environment settings
				backgroundColor: { type: 'object' },
				ambientLightColor: { type: 'object' },
				fogEnabled: { type: 'boolean' },
				// Camera attributes
				dofBlurFar: { type: 'number' },
				exposureMultiplier: { type: 'number' },
			},
			required: ['action'],
			},
		},
		{
			name: 'game_navigation',
			description: '2D/3D navigation pathfinding and queries',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['path_2d', 'path_3d', 'bake_navigation'] },
				start: { type: 'object' },
				end: { type: 'object' },
				optimize: { type: 'boolean', default: true },
				nodePath: { type: 'string', description: 'For bake_navigation' },
			},
			required: ['action'],
			},
		},
		{
			name: 'game_tilemap',
			description: 'Get or set cells in TileMap/TileMapLayer',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['set_cells', 'get_cell', 'erase_cells', 'get_used_cells'] },
				nodePath: { type: 'string' },
				x: { type: 'number' },
				y: { type: 'number' },
				cells: { type: 'array' },
				sourceId: { type: 'number' },
			},
			required: ['action', 'nodePath'],
			},
		},
		{
			name: 'game_particles',
			description: 'Configure GPUParticles2D/3D',
			inputSchema: {
			type: 'object',
			properties: {
				nodePath: { type: 'string' },
				emitting: { type: 'boolean' },
				amount: { type: 'number' },
				lifetime: { type: 'number' },
				oneShot: { type: 'boolean' },
				speedScale: { type: 'number' },
			},
			required: ['nodePath'],
			},
		},

		// === NETWORKING & SYSTEM (3 tools) ===
		{
			name: 'game_networking',
			description: 'HTTP, WebSocket, and multiplayer networking',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['http_request', 'websocket_connect', 'websocket_send', 'websocket_disconnect', 'create_server', 'create_client', 'disconnect'] },
				url: { type: 'string' },
				method: { type: 'string', default: 'GET' },
				headers: { type: 'object' },
				body: { type: 'string' },
				message: { type: 'string', description: 'For websocket_send' },
				port: { type: 'number', default: 7000 },
				address: { type: 'string', default: '127.0.0.1' },
			},
			required: ['action'],
			},
		},
		{
			name: 'game_system',
			description: 'System and window management',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['get_os_info', 'get_time_scale', 'set_time_scale', 'set_window', 'set_process_mode'] },
				timeScale: { type: 'number' },
				width: { type: 'number' },
				height: { type: 'number' },
				fullscreen: { type: 'boolean' },
				nodePath: { type: 'string', description: 'For set_process_mode' },
				mode: { type: 'string', description: 'For set_process_mode: inherit, pausable, always, disabled' },
			},
			required: ['action'],
			},
		},
		{
			name: 'game_serialization',
			description: 'Save/load node tree state',
			inputSchema: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['save_state', 'load_state'] },
				nodePath: { type: 'string', default: '/root' },
				data: { type: 'object', description: 'For load_state' },
				maxDepth: { type: 'number', default: 5 },
			},
			required: ['action'],
			},
		},

		// === EXPORT & DEPLOYMENT (3 tools) ===
		{
			name: 'export_project',
			description: 'Export Godot project using preset',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				presetName: { type: 'string' },
				outputPath: { type: 'string' },
				debug: { type: 'boolean', default: false },
			},
			required: ['projectPath', 'presetName', 'outputPath'],
			},
		},
		{
			name: 'manage_ci_cd',
			description: 'Create CI/CD pipeline or Docker export',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				action: { type: 'string', enum: ['create_ci_pipeline', 'create_dockerfile', 'read_ci_pipeline', 'read_dockerfile'] },
				platforms: { type: 'array', items: { type: 'string' } },
				godotVersion: { type: 'string', default: '4.3-stable' },
				exportPreset: { type: 'string' },
			},
			required: ['projectPath', 'action'],
			},
		},
		{
			name: 'manage_uid',
			description: 'Get or update UIDs (Godot 4.4+)',
			inputSchema: {
			type: 'object',
			properties: {
				projectPath: { type: 'string' },
				action: { type: 'string', enum: ['get_uid', 'update_project_uids'] },
				filePath: { type: 'string', description: 'For get_uid' },
			},
			required: ['projectPath', 'action'],
			},
		},
		],
	}));

	// Handle tool calls
	this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		this.logDebug(`Handling tool request: ${request.params.name}`);
		switch (request.params.name) {
		// === CORE PROJECT ===
		case 'launch_editor':
			return await this.handleLaunchEditor(request.params.arguments);
		case 'run_project':
			return await this.handleRunProject(request.params.arguments);
		case 'stop_project':
			return await this.handleStopProject();
		case 'get_debug_output':
			return await this.handleGetDebugOutput();
		case 'get_godot_version':
			return await this.handleGetGodotVersion();
		case 'list_projects':
			return await this.handleListProjects(request.params.arguments);
		case 'get_project_info':
			return await this.handleGetProjectInfo(request.params.arguments);
		case 'create_project':
			return await this.handleCreateProject(request.params.arguments);

		// === SCENE MANAGEMENT ===
		case 'manage_scene':
			return await this.handleManageScene(request.params.arguments);
		case 'manage_scene_structure':
			return await this.handleManageSceneStructure(request.params.arguments);
		case 'manage_scene_signals':
			return await this.handleManageSceneSignals(request.params.arguments);
		case 'export_mesh_library':
			return await this.handleExportMeshLibrary(request.params.arguments);

		// === FILE OPERATIONS ===
		case 'manage_file':
			return await this.handleManageFile(request.params.arguments);
		case 'create_directory':
			return await this.handleCreateDirectory(request.params.arguments);
		case 'list_project_files':
			return await this.handleListProjectFiles(request.params.arguments);
		case 'create_script':
			return await this.handleCreateScript(request.params.arguments);
		case 'manage_resource':
			return await this.handleManageResource(request.params.arguments);

		// === PROJECT SETTINGS ===
		case 'manage_project_settings':
			return await this.handleManageProjectSettings(request.params.arguments);
		case 'manage_autoloads':
			return await this.handleManageAutoloads(request.params.arguments);
		case 'manage_input_map':
			return await this.handleManageInputMap(request.params.arguments);
		case 'manage_export_presets':
			return await this.handleManageExportPresets(request.params.arguments);

		// === GAME INPUT ===
		case 'game_mouse_input':
			return await this.handleGameMouseInput(request.params.arguments);
		case 'game_keyboard_input':
			return await this.handleGameKeyboardInput(request.params.arguments);

		// === GAME STATE ===
		case 'game_screenshot':
			return await this.handleGameScreenshot();
		case 'game_eval':
			return await this.handleGameEval(request.params.arguments);
		case 'game_get_info':
			return await this.handleGameGetInfo(request.params.arguments);

		// === NODE OPERATIONS ===
		case 'game_node_property':
			return await this.handleGameNodeProperty(request.params.arguments);
		case 'game_node_method':
			return await this.handleGameNodeMethod(request.params.arguments);
		case 'game_scene_management':
			return await this.handleGameSceneManagement(request.params.arguments);

		// === SIGNALS & ANIMATION ===
		case 'game_signal':
			return await this.handleGameSignal(request.params.arguments);
		case 'game_animation':
			return await this.handleGameAnimation(request.params.arguments);
		case 'game_tween':
			return await this.handleGameTween(request.params.arguments);

		// === PHYSICS & COLLISION ===
		case 'game_physics_query':
			return await this.handleGamePhysicsQuery(request.params.arguments);
		case 'game_physics_body':
			return await this.handleGamePhysicsBody(request.params.arguments);

		// === AUDIO ===
		case 'game_audio':
			return await this.handleGameAudio(request.params.arguments);
		case 'game_audio_bus':
			return await this.handleGameAudioBus(request.params.arguments);

		// === UI CONTROLS ===
		case 'game_ui_control':
			return await this.handleGameUiControl(request.params.arguments);
		case 'game_ui_container':
			return await this.handleGameUiContainer(request.params.arguments);

		// === ADVANCED FEATURES ===
		case 'game_rendering':
			return await this.handleGameRendering(request.params.arguments);
		case 'game_navigation':
			return await this.handleGameNavigation(request.params.arguments);
		case 'game_tilemap':
			return await this.handleGameTilemap(request.params.arguments);

		// === NETWORKING & SYSTEM ===
		case 'game_networking':
			return await this.handleGameNetworking(request.params.arguments);
		case 'game_system':
			return await this.handleGameSystem(request.params.arguments);
		case 'game_serialization':
			return await this.handleGameSerialization(request.params.arguments);

		// === EXPORT & DEPLOYMENT ===
		case 'export_project':
			return await this.handleExportProject(request.params.arguments);
		case 'manage_ci_cd':
			return await this.handleManageCiCd(request.params.arguments);
		case 'manage_uid':
			return await this.handleManageUid(request.params.arguments);

		default:
			throw new McpError(
			ErrorCode.MethodNotFound,
			`Unknown tool: ${request.params.name}`
			);
		}
	});
	}

	/**
	 * Handle the launch_editor tool
	 * @param args Tool arguments
	 */
	private async handleLaunchEditor(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		// Support auto-detection from any path within project
		const resolvedPath = this.resolveProjectPath(args.projectPath, args.projectPath);
		if (!resolvedPath) {
			return createErrorResponse(
				'Project path is required and could not be auto-detected. Provide a path to a Godot project or any file within one.'
			);
		}
		args.projectPath = resolvedPath;

		if (!validatePath(args.projectPath)) {
			return createErrorResponse(
				'Invalid project path'
			);
		}

		try {
			// Ensure godotPath is set
			if (!this.godotPath) {
				await this.detectGodotPath();
				if (!this.godotPath) {
					return createErrorResponse(
						'Could not find a valid Godot executable path'
					);
				}
			}

			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}

			this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
			const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
				stdio: 'pipe',
			});

			process.on('error', (err: Error) => {
				console.error('Failed to start Godot editor:', err);
			});

			return {
				content: [
					{
						type: 'text',
						text: `Godot editor launched successfully for project at ${args.projectPath}.`,
					},
				],
			};
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return createErrorResponse(
				`Failed to launch Godot editor: ${errorMessage}`
			);
		}
	}

	/**
	 * Handle the run_project tool
	 * @param args Tool arguments
	 */
	private async handleRunProject(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		// Support auto-detection from any path within project
		const resolvedPath = this.resolveProjectPath(args.projectPath, args.projectPath);
		if (!resolvedPath) {
			return createErrorResponse(
				'Project path is required and could not be auto-detected. Provide a path to a Godot project or any file within one.'
			);
		}
		args.projectPath = resolvedPath;

		if (!validatePath(args.projectPath)) {
			return createErrorResponse(
				'Invalid project path'
			);
		}

		try {
			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}

			// Kill any existing process
			if (this.activeProcess) {
				this.logDebug('Killing existing Godot process before starting a new one');
				this.disconnectFromGame();
				if (this.gameConnection.projectPath) {
					this.removeInteractionServer(this.gameConnection.projectPath);
				}
				this.activeProcess.process.kill();
			}

			// Inject interaction server before launching
			this.injectInteractionServer(args.projectPath);

			const cmdArgs = ['-d', '--path', args.projectPath];
			if (args.scene && validatePath(args.scene)) {
				this.logDebug(`Adding scene parameter: ${args.scene}`);
				cmdArgs.push(args.scene);
			}

			this.logDebug(`Running Godot project: ${args.projectPath}`);
			const process = spawn(this.godotPath!, cmdArgs, { stdio: 'pipe' });
			const output: string[] = [];
			const errors: string[] = [];

			process.stdout?.on('data', (data: Buffer) => {
				const lines = data.toString().split('\n');
				output.push(...lines);
				lines.forEach((line: string) => {
					if (line.trim()) this.logDebug(`[Godot stdout] ${line}`);
				});
			});

			process.stderr?.on('data', (data: Buffer) => {
				const lines = data.toString().split('\n');
				errors.push(...lines);
				lines.forEach((line: string) => {
					if (line.trim()) this.logDebug(`[Godot stderr] ${line}`);
				});
			});

			process.on('exit', (code: number | null) => {
				this.logDebug(`Godot process exited with code ${code}`);
				this.disconnectFromGame();
				if (this.gameConnection.projectPath) {
					this.removeInteractionServer(this.gameConnection.projectPath);
					this.gameConnection.projectPath = null;
				}
				if (this.activeProcess && this.activeProcess.process === process) {
					this.activeProcess = null;
				}
			});

			process.on('error', (err: Error) => {
				console.error('Failed to start Godot process:', err);
				if (this.activeProcess && this.activeProcess.process === process) {
					this.activeProcess = null;
				}
			});

			this.activeProcess = { process, output, errors };

			// Start async TCP connection to the interaction server (fire-and-forget)
			this.connectToGame(args.projectPath).catch(err => {
				this.logDebug(`Failed to connect to game interaction server: ${err}`);
			});

			return {
				content: [
					{
						type: 'text',
						text: `Godot project started in debug mode. Use get_debug_output to see output. Game interaction server connecting on port ${this.INTERACTION_PORT}...`,
					},
				],
			};
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return createErrorResponse(
				`Failed to run Godot project: ${errorMessage}`
			);
		}
	}

	/**
	 * Handle the get_debug_output tool
	 */
	private async handleGetDebugOutput() {
		if (!this.activeProcess) {
			return createErrorResponse(
				'No active Godot process.'
			);
		}

		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(
						{
							output: this.activeProcess.output,
							errors: this.activeProcess.errors,
						},
						null,
						2
					),
				},
			],
		};
	}

	/**
	 * Handle the stop_project tool
	 */
	private async handleStopProject() {
		if (!this.activeProcess) {
			return createErrorResponse(
				'No active Godot process to stop.'
			);
		}

		this.logDebug('Stopping active Godot process');
		this.disconnectFromGame();
		this.activeProcess.process.kill();
		const output = this.activeProcess.output;
		const errors = this.activeProcess.errors;
		this.activeProcess = null;
		this.lastErrorIndex = 0;
		this.lastLogIndex = 0;

		// Remove injected interaction server
		if (this.gameConnection.projectPath) {
			this.removeInteractionServer(this.gameConnection.projectPath);
			this.gameConnection.projectPath = null;
		}

		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(
						{
							message: 'Godot project stopped',
							finalOutput: output,
							finalErrors: errors,
						},
						null,
						2
					),
				},
			],
		};
	}

	/**
	 * Handle the get_godot_version tool
	 */
	private async handleGetGodotVersion() {
		try {
			// Ensure godotPath is set
			if (!this.godotPath) {
				await this.detectGodotPath();
				if (!this.godotPath) {
					return createErrorResponse(
						'Could not find a valid Godot executable path'
					);
				}
			}

			this.logDebug('Getting Godot version');
			const { stdout } = await execFileAsync(this.godotPath!, ['--version']);
			return {
				content: [
					{
						type: 'text',
						text: stdout.trim(),
					},
				],
			};
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return createErrorResponse(
				`Failed to get Godot version: ${errorMessage}`
			);
		}
	}

	/**
	 * Handle the list_projects tool
	 */
	private async handleListProjects(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		if (!args.directory) {
			return createErrorResponse(
				'Directory is required'
			);
		}

		if (!validatePath(args.directory)) {
			return createErrorResponse(
				'Invalid directory path'
			);
		}

		try {
			this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
			if (!existsSync(args.directory)) {
				return createErrorResponse(
					`Directory does not exist: ${args.directory}`
				);
			}

			const recursive = args.recursive === true;
			const projects = this.findGodotProjects(args.directory, recursive);

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(projects, null, 2),
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(
				`Failed to list projects: ${error?.message || 'Unknown error'}`
			);
		}
	}

	/**
	 * Get the structure of a Godot project asynchronously by counting files recursively
	 * @param projectPath Path to the Godot project
	 * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
	 */
	private getProjectStructureAsync(projectPath: string): Promise<any> {
		return new Promise((resolve) => {
			try {
				const structure = {
					scenes: 0,
					scripts: 0,
					assets: 0,
					other: 0,
				};

				const scanDirectory = (currentPath: string) => {
					const entries = readdirSync(currentPath, { withFileTypes: true });
					
					for (const entry of entries) {
						const entryPath = join(currentPath, entry.name);
						
						// Skip hidden files and directories
						if (entry.name.startsWith('.')) {
							continue;
						}
						
						if (entry.isDirectory()) {
							// Recursively scan subdirectories
							scanDirectory(entryPath);
						} else if (entry.isFile()) {
							// Count file by extension
							const ext = entry.name.split('.').pop()?.toLowerCase();
							
							if (ext === 'tscn') {
								structure.scenes++;
							} else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
								structure.scripts++;
							} else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
								structure.assets++;
							} else {
								structure.other++;
							}
						}
					}
				};
				
				// Start scanning from the project root
				scanDirectory(projectPath);
				resolve(structure);
			} catch (error) {
				this.logDebug(`Error getting project structure asynchronously: ${error}`);
				resolve({ 
					error: 'Failed to get project structure',
					scenes: 0,
					scripts: 0,
					assets: 0,
					other: 0
				});
			}
		});
	}

	/**
	 * Handle the get_project_info tool
	 */
	private async handleGetProjectInfo(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		if (!args.projectPath) {
			return createErrorResponse(
				'Project path is required'
			);
		}
	
		if (!validatePath(args.projectPath)) {
			return createErrorResponse(
				'Invalid project path'
			);
		}
	
		try {
			// Ensure godotPath is set
			if (!this.godotPath) {
				await this.detectGodotPath();
				if (!this.godotPath) {
					return createErrorResponse(
						'Could not find a valid Godot executable path'
					);
				}
			}
	
			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}
	
			this.logDebug(`Getting project info for: ${args.projectPath}`);
	
			// Get Godot version
			const execOptions = { timeout: 10000 }; // 10 second timeout
			const { stdout } = await execFileAsync(this.godotPath!, ['--version'], execOptions);
	
			// Get project structure using the recursive method
			const projectStructure = await this.getProjectStructureAsync(args.projectPath);
	
			// Extract project name from project.godot file
			let projectName = basename(args.projectPath);
			try {
				const projectFileContent = readFileSync(projectFile, 'utf8');
				const configNameMatch = projectFileContent.match(/config\/name="([^"]+)"/);
				if (configNameMatch && configNameMatch[1]) {
					projectName = configNameMatch[1];
					this.logDebug(`Found project name in config: ${projectName}`);
				}
			} catch (error) {
				this.logDebug(`Error reading project file: ${error}`);
				// Continue with default project name if extraction fails
			}
	
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								name: projectName,
								path: args.projectPath,
								godotVersion: stdout.trim(),
								structure: projectStructure,
							},
							null,
							2
						),
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(
				`Failed to get project info: ${error?.message || 'Unknown error'}`
			);
		}
	}

	/**
	 * Handle the create_scene tool
	 */
	private async handleCreateScene(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		// scenePath can be absolute or relative - use it to auto-detect project
		const contextPath = args.scenePath ? path.join(args.projectPath || '.', args.scenePath) : args.projectPath;
		const resolvedPath = this.resolveProjectPath(args.projectPath, contextPath);
		if (!resolvedPath) {
			return createErrorResponse(
				'Project path is required and could not be auto-detected. Provide projectPath or ensure scenePath is within a Godot project.'
			);
		}
		args.projectPath = resolvedPath;
		
		if (!args.scenePath) {
			return createErrorResponse('scenePath is required');
		}

		if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
			return createErrorResponse(
				'Invalid path'
			);
		}

		try {
			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}

			// Prepare parameters for the operation (already in camelCase)
			const params = {
				scenePath: args.scenePath,
				rootNodeType: args.rootNodeType || 'Node2D',
			};

			// Execute the operation
			const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

			if (stderr && stderr.includes('Failed to')) {
				return createErrorResponse(
					`Failed to create scene: ${stderr}`
				);
			}

			return {
				content: [
					{
						type: 'text',
						text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(
				`Failed to create scene: ${error?.message || 'Unknown error'}`
			);
		}
	}

	/**
	 * Handle the add_node tool
	 */
	private async handleAddNode(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
			return createErrorResponse(
				'Missing required parameters'
			);
		}

		// scenePath can be absolute or relative - use it to auto-detect project
		const contextPath = args.scenePath ? path.join(args.projectPath || '.', args.scenePath) : args.projectPath;
		const resolvedPath = this.resolveProjectPath(args.projectPath, contextPath);
		if (!resolvedPath) {
			return createErrorResponse(
				'Project path is required and could not be auto-detected. Provide projectPath or ensure scenePath is within a Godot project.'
			);
		}
		args.projectPath = resolvedPath;
		
		if (!args.scenePath) {
			return createErrorResponse('scenePath is required');
		}

		try {
			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}

			// Check if the scene file exists
			const scenePath = join(args.projectPath, args.scenePath);
			if (!existsSync(scenePath)) {
				return createErrorResponse(
					`Scene file does not exist: ${args.scenePath}`
				);
			}

			// Prepare parameters for the operation (already in camelCase)
			const params: any = {
				scenePath: args.scenePath,
				nodeType: args.nodeType,
				nodeName: args.nodeName,
			};

			// Add optional parameters
			if (args.parentNodePath) {
				params.parentNodePath = args.parentNodePath;
			}

			if (args.properties) {
				params.properties = args.properties;
			}

			// Execute the operation
			const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

			if (stderr && stderr.includes('Failed to')) {
				return createErrorResponse(
					`Failed to add node: ${stderr}`
				);
			}

			return {
				content: [
					{
						type: 'text',
						text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(
				`Failed to add node: ${error?.message || 'Unknown error'}`
			);
		}
	}

	/**
	 * Handle the load_sprite tool
	 */
	private async handleLoadSprite(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
			return createErrorResponse(
				'Missing required parameters'
			);
		}

		if (
			!validatePath(args.projectPath) ||
			!validatePath(args.scenePath) ||
			!validatePath(args.nodePath) ||
			!validatePath(args.texturePath)
		) {
			return createErrorResponse(
				'Invalid path'
			);
		}

		try {
			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}

			// Check if the scene file exists
			const scenePath = join(args.projectPath, args.scenePath);
			if (!existsSync(scenePath)) {
				return createErrorResponse(
					`Scene file does not exist: ${args.scenePath}`
				);
			}

			// Check if the texture file exists
			const texturePath = join(args.projectPath, args.texturePath);
			if (!existsSync(texturePath)) {
				return createErrorResponse(
					`Texture file does not exist: ${args.texturePath}`
				);
			}

			// Prepare parameters for the operation (already in camelCase)
			const params = {
				scenePath: args.scenePath,
				nodePath: args.nodePath,
				texturePath: args.texturePath,
			};

			// Execute the operation
			const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

			if (stderr && stderr.includes('Failed to')) {
				return createErrorResponse(
					`Failed to load sprite: ${stderr}`
				);
			}

			return {
				content: [
					{
						type: 'text',
						text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(
				`Failed to load sprite: ${error?.message || 'Unknown error'}`
			);
		}
	}

	/**
	 * Handle the export_mesh_library tool
	 */
	private async handleExportMeshLibrary(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		if (!args.projectPath || !args.scenePath || !args.outputPath) {
			return createErrorResponse(
				'Missing required parameters'
			);
		}

		if (
			!validatePath(args.projectPath) ||
			!validatePath(args.scenePath) ||
			!validatePath(args.outputPath)
		) {
			return createErrorResponse(
				'Invalid path'
			);
		}

		try {
			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}

			// Check if the scene file exists
			const scenePath = join(args.projectPath, args.scenePath);
			if (!existsSync(scenePath)) {
				return createErrorResponse(
					`Scene file does not exist: ${args.scenePath}`
				);
			}

			// Prepare parameters for the operation (already in camelCase)
			const params: any = {
				scenePath: args.scenePath,
				outputPath: args.outputPath,
			};

			// Add optional parameters
			if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
				params.meshItemNames = args.meshItemNames;
			}

			// Execute the operation
			const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

			if (stderr && stderr.includes('Failed to')) {
				return createErrorResponse(
					`Failed to export mesh library: ${stderr}`
				);
			}

			return {
				content: [
					{
						type: 'text',
						text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(
				`Failed to export mesh library: ${error?.message || 'Unknown error'}`
			);
		}
	}

	/**
	 * Handle the save_scene tool
	 */
	private async handleSaveScene(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		if (!args.projectPath || !args.scenePath) {
			return createErrorResponse(
				'Missing required parameters'
			);
		}

		if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
			return createErrorResponse(
				'Invalid path'
			);
		}

		// If newPath is provided, validate it
		if (args.newPath && !validatePath(args.newPath)) {
			return createErrorResponse(
				'Invalid new path'
			);
		}

		try {
			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}

			// Check if the scene file exists
			const scenePath = join(args.projectPath, args.scenePath);
			if (!existsSync(scenePath)) {
				return createErrorResponse(
					`Scene file does not exist: ${args.scenePath}`
				);
			}

			// Prepare parameters for the operation (already in camelCase)
			const params: any = {
				scenePath: args.scenePath,
			};

			// Add optional parameters
			if (args.newPath) {
				params.newPath = args.newPath;
			}

			// Execute the operation
			const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

			if (stderr && stderr.includes('Failed to')) {
				return createErrorResponse(
					`Failed to save scene: ${stderr}`
				);
			}

			const savePath = args.newPath || args.scenePath;
			return {
				content: [
					{
						type: 'text',
						text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(
				`Failed to save scene: ${error?.message || 'Unknown error'}`
			);
		}
	}

	/**
	 * Handle the get_uid tool
	 */
	private async handleGetUid(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		if (!args.projectPath || !args.filePath) {
			return createErrorResponse(
				'Missing required parameters'
			);
		}

		if (!validatePath(args.projectPath) || !validatePath(args.filePath)) {
			return createErrorResponse(
				'Invalid path'
			);
		}

		try {
			// Ensure godotPath is set
			if (!this.godotPath) {
				await this.detectGodotPath();
				if (!this.godotPath) {
					return createErrorResponse(
						'Could not find a valid Godot executable path'
					);
				}
			}

			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}

			// Check if the file exists
			const filePath = join(args.projectPath, args.filePath);
			if (!existsSync(filePath)) {
				return createErrorResponse(
					`File does not exist: ${args.filePath}`
				);
			}

			// Get Godot version to check if UIDs are supported
			const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
			const version = versionOutput.trim();

			if (!isGodot44OrLater(version)) {
				return createErrorResponse(
					`UIDs are only supported in Godot 4.4 or later. Current version: ${version}`
				);
			}

			// Prepare parameters for the operation (already in camelCase)
			const params = {
				filePath: args.filePath,
			};

			// Execute the operation
			const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

			if (stderr && stderr.includes('Failed to')) {
				return createErrorResponse(
					`Failed to get UID: ${stderr}`
				);
			}

			return {
				content: [
					{
						type: 'text',
						text: `UID for ${args.filePath}: ${stdout.trim()}`,
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(
				`Failed to get UID: ${error?.message || 'Unknown error'}`
			);
		}
	}


	/**
	 * Handle the game_screenshot tool
	 */
	private async handleGameScreenshot() {
		if (!this.activeProcess) {
			return createErrorResponse('No active Godot process. Use run_project first.');
		}
		if (!this.gameConnection.connected) {
			return createErrorResponse('Not connected to game interaction server. Wait a moment and try again.');
		}

		try {
			const response = await this.sendGameCommand('screenshot');
			if (response.error) {
				return createErrorResponse(`Screenshot failed: ${response.error}`);
			}
			return {
				content: [
					{
						type: 'image',
						data: response.data,
						mimeType: 'image/png',
					},
					{
						type: 'text',
						text: `Screenshot captured: ${response.width}x${response.height}`,
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(`Screenshot failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleGameClick(args: any) {
		return this.gameCommand('click', args, a => ({ x: a.x ?? 0, y: a.y ?? 0, button: a.button ?? 1 }));
	}

	private async handleGameKeyPress(args: any) {
		args = args || {};
		if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
		const params: Record<string, any> = {};
		if (args.key) params.key = args.key;
		if (args.action) params.action = args.action;
		if (args.pressed !== undefined) params.pressed = args.pressed;
		return this.gameCommand('key_press', args, () => params);
	}

	private async handleGameMouseMove(args: any) {
		return this.gameCommand('mouse_move', args, a => ({
			x: a.x ?? 0, y: a.y ?? 0, relative_x: a.relative_x ?? 0, relative_y: a.relative_y ?? 0,
		}));
	}

	private async handleGameGetUi() {
		return this.gameCommand('get_ui_elements', {}, () => ({}));
	}

	private async handleGameGetSceneTree() {
		return this.gameCommand('get_scene_tree', {}, () => ({}));
	}

	private async handleGameEval(args: any) {
		args = normalizeParameters(args || {});
		if (!args.code) return createErrorResponse('code parameter is required.');
		return this.gameCommand('eval', args, a => ({ code: a.code }), 30000);
	}

	private async handleGameGetProperty(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.property) return createErrorResponse('nodePath and property are required.');
		return this.gameCommand('get_property', args, a => ({ node_path: a.nodePath, property: a.property }));
	}

	private async handleGameSetProperty(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.property) return createErrorResponse('nodePath and property are required.');
		return this.gameCommand('set_property', args, a => ({
			node_path: a.nodePath, property: a.property, value: a.value, type_hint: a.typeHint || '',
		}));
	}

	private async handleGameCallMethod(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.method) return createErrorResponse('nodePath and method are required.');
		return this.gameCommand('call_method', args, a => ({
			node_path: a.nodePath, method: a.method, args: a.args || [],
		}));
	}

	private async handleGameGetNodeInfo(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath) return createErrorResponse('nodePath is required.');
		return this.gameCommand('get_node_info', args, a => ({ node_path: a.nodePath }));
	}

	private async handleGameInstantiateScene(args: any) {
		args = normalizeParameters(args || {});
		if (!args.scenePath) return createErrorResponse('scenePath is required.');
		return this.gameCommand('instantiate_scene', args, a => ({
			scene_path: a.scenePath, parent_path: a.parentPath || '/root',
		}));
	}

	private async handleGameRemoveNode(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath) return createErrorResponse('nodePath is required.');
		return this.gameCommand('remove_node', args, a => ({ node_path: a.nodePath }));
	}

	private async handleGameChangeScene(args: any) {
		args = normalizeParameters(args || {});
		if (!args.scenePath) return createErrorResponse('scenePath is required.');
		return this.gameCommand('change_scene', args, a => ({ scene_path: a.scenePath }));
	}

	private async handleGamePause(args: any) {
		return this.gameCommand('pause', args, a => ({ paused: a.paused !== undefined ? a.paused : true }));
	}

	private async handleGamePerformance() {
		return this.gameCommand('get_performance', {}, () => ({}));
	}

	private async handleGameWait(args: any) {
		return this.gameCommand('wait', args, a => ({ frames: a.frames || 1 }), 30000);
	}


	/**
	 * Handle the read_scene tool - Read a scene file structure
	 */
	private async handleReadScene(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.scenePath) {
			return createErrorResponse('projectPath and scenePath are required.');
		}

		if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
			return createErrorResponse('Invalid path.');
		}

		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) {
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		}

		const scenePath = join(args.projectPath, args.scenePath);
		if (!existsSync(scenePath)) {
			return createErrorResponse(`Scene file does not exist: ${args.scenePath}`);
		}

		try {
			const { stdout, stderr } = await this.executeOperation('read_scene', {
				scenePath: args.scenePath,
			}, args.projectPath);

			// Extract JSON from the SCENE_JSON_START/END markers
			const startMarker = 'SCENE_JSON_START';
			const endMarker = 'SCENE_JSON_END';
			const startIdx = stdout.indexOf(startMarker);
			const endIdx = stdout.indexOf(endMarker);

			if (startIdx !== -1 && endIdx !== -1) {
				const jsonStr = stdout.substring(startIdx + startMarker.length, endIdx).trim();
				try {
					const parsed = JSON.parse(jsonStr);
					return {
						content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
					};
				} catch {
					return {
						content: [{ type: 'text', text: `Raw scene data:\n${jsonStr}` }],
					};
				}
			}

			return {
				content: [{ type: 'text', text: `Scene read output:\n${stdout}\n${stderr ? 'Errors:\n' + stderr : ''}` }],
			};
		} catch (error: any) {
			return createErrorResponse(`Failed to read scene: ${error?.message || 'Unknown error'}`);
		}
	}

	/**
	 * Handle the modify_scene_node tool
	 */
	private async handleModifySceneNode(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.scenePath || !args.nodePath || !args.properties)
			return createErrorResponse('projectPath, scenePath, nodePath, and properties are required.');
		return this.headlessOp('modify_node', args, a => ({
			projectPath: a.projectPath,
			params: { scenePath: a.scenePath, nodePath: a.nodePath, properties: a.properties },
		}));
	}

	private async handleRemoveSceneNode(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.scenePath || !args.nodePath)
			return createErrorResponse('projectPath, scenePath, and nodePath are required.');
		return this.headlessOp('remove_node', args, a => ({
			projectPath: a.projectPath,
			params: { scenePath: a.scenePath, nodePath: a.nodePath },
		}));
	}


	/**
	 * Handle the read_project_settings tool - Parse project.godot as JSON
	 */
	private async handleReadProjectSettings(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath) {
			return createErrorResponse('projectPath is required.');
		}

		if (!validatePath(args.projectPath)) {
			return createErrorResponse('Invalid path.');
		}

		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) {
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		}

		try {
			const content = readFileSync(projectFile, 'utf8');
			const sections: Record<string, Record<string, string>> = {};
			let currentSection = '';

			for (const line of content.split('\n')) {
				const trimmed = line.trim();
				if (trimmed === '' || trimmed.startsWith(';')) continue;

				// Section header
				const sectionMatch = trimmed.match(/^\[(.+)\]$/);
				if (sectionMatch) {
					currentSection = sectionMatch[1];
					if (!sections[currentSection]) {
						sections[currentSection] = {};
					}
					continue;
				}

				// Key=value pair
				const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
				if (kvMatch && currentSection) {
					const key = kvMatch[1].trim();
					const value = kvMatch[2].trim();
					sections[currentSection][key] = value;
				}
			}

			return {
				content: [{ type: 'text', text: JSON.stringify(sections, null, 2) }],
			};
		} catch (error: any) {
			return createErrorResponse(`Failed to read project settings: ${error?.message || 'Unknown error'}`);
		}
	}

	/**
	 * Handle the modify_project_settings tool - Change a project.godot setting
	 */
	private async handleModifyProjectSettings(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.section || !args.key || args.value === undefined) {
			return createErrorResponse('projectPath, section, key, and value are required.');
		}

		if (!validatePath(args.projectPath)) {
			return createErrorResponse('Invalid path.');
		}

		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) {
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		}

		try {
			let content = readFileSync(projectFile, 'utf8');
			const sectionHeader = `[${args.section}]`;
			const keyLine = `${args.key}=${args.value}`;

			// Check if section exists
			const sectionIdx = content.indexOf(sectionHeader);
			if (sectionIdx !== -1) {
				// Section exists - look for existing key
				const sectionEnd = content.indexOf('\n[', sectionIdx + sectionHeader.length);
				const sectionContent = sectionEnd !== -1
					? content.substring(sectionIdx, sectionEnd)
					: content.substring(sectionIdx);

				// Try to find and replace existing key
				const keyPattern = new RegExp(`^${args.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
				if (keyPattern.test(sectionContent)) {
					// Replace existing key
					const newSectionContent = sectionContent.replace(keyPattern, keyLine);
					content = content.substring(0, sectionIdx) + newSectionContent +
						(sectionEnd !== -1 ? content.substring(sectionEnd) : '');
				} else {
					// Add key to existing section
					const insertPos = sectionIdx + sectionHeader.length;
					content = content.substring(0, insertPos) + '\n' + keyLine + content.substring(insertPos);
				}
			} else {
				// Add new section at end
				content += `\n\n${sectionHeader}\n\n${keyLine}\n`;
			}

			writeFileSync(projectFile, content, 'utf8');
			return {
				content: [{ type: 'text', text: `Setting updated: [${args.section}] ${args.key}=${args.value}` }],
			};
		} catch (error: any) {
			return createErrorResponse(`Failed to modify project settings: ${error?.message || 'Unknown error'}`);
		}
	}

	/**
	 * Handle the list_project_files tool - List files with extension filtering
	 */
	private async handleListProjectFiles(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath) {
			return createErrorResponse('projectPath is required.');
		}

		if (!validatePath(args.projectPath)) {
			return createErrorResponse('Invalid path.');
		}

		if (!existsSync(args.projectPath)) {
			return createErrorResponse(`Directory does not exist: ${args.projectPath}`);
		}

		try {
			const baseDir = args.subdirectory
				? join(args.projectPath, args.subdirectory)
				: args.projectPath;

			if (!existsSync(baseDir)) {
				return createErrorResponse(`Subdirectory does not exist: ${args.subdirectory}`);
			}

			const files: string[] = [];
			const extensions: string[] | undefined = args.extensions;

			const scanDir = (dir: string, relativeTo: string) => {
				const entries = readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.name.startsWith('.')) continue;
					const fullPath = join(dir, entry.name);
					const relativePath = fullPath.substring(relativeTo.length + 1).replace(/\\/g, '/');

					if (entry.isDirectory()) {
						scanDir(fullPath, relativeTo);
					} else if (entry.isFile()) {
						if (extensions && extensions.length > 0) {
							const ext = '.' + entry.name.split('.').pop();
							if (extensions.includes(ext)) {
								files.push(relativePath);
							}
						} else {
							files.push(relativePath);
						}
					}
				}
			};

			scanDir(baseDir, args.projectPath);

			return {
				content: [{ type: 'text', text: JSON.stringify({ count: files.length, files }, null, 2) }],
			};
		} catch (error: any) {
			return createErrorResponse(`Failed to list project files: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleGameConnectSignal(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.signalName || !args.targetPath || !args.method)
			return createErrorResponse('nodePath, signalName, targetPath, and method are required.');
		return this.gameCommand('connect_signal', args, a => ({
			node_path: a.nodePath, signal_name: a.signalName, target_path: a.targetPath, method: a.method,
		}));
	}

	private async handleGameDisconnectSignal(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.signalName || !args.targetPath || !args.method)
			return createErrorResponse('nodePath, signalName, targetPath, and method are required.');
		return this.gameCommand('disconnect_signal', args, a => ({
			node_path: a.nodePath, signal_name: a.signalName, target_path: a.targetPath, method: a.method,
		}));
	}

	private async handleGameEmitSignal(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.signalName) return createErrorResponse('nodePath and signalName are required.');
		return this.gameCommand('emit_signal', args, a => ({
			node_path: a.nodePath, signal_name: a.signalName, args: a.args || [],
		}));
	}

	private async handleGamePlayAnimation(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath) return createErrorResponse('nodePath is required.');
		return this.gameCommand('play_animation', args, a => ({
			node_path: a.nodePath, action: a.action || 'play', animation: a.animation || '',
		}));
	}

	private async handleGameTweenProperty(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.property || args.finalValue === undefined)
			return createErrorResponse('nodePath, property, and finalValue are required.');
		return this.gameCommand('tween_property', args, a => ({
			node_path: a.nodePath, property: a.property, final_value: a.finalValue,
			duration: a.duration || 1.0, trans_type: a.transType || 0, ease_type: a.easeType || 2,
		}));
	}

	private async handleGameGetNodesInGroup(args: any) {
		args = normalizeParameters(args || {});
		if (!args.group) return createErrorResponse('group is required.');
		return this.gameCommand('get_nodes_in_group', args, a => ({ group: a.group }));
	}

	private async handleGameFindNodesByClass(args: any) {
		args = normalizeParameters(args || {});
		if (!args.className) return createErrorResponse('className is required.');
		return this.gameCommand('find_nodes_by_class', args, a => ({
			class_name: a.className, root_path: a.rootPath || '/root',
		}));
	}

	private async handleGameReparentNode(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.newParentPath) return createErrorResponse('nodePath and newParentPath are required.');
		return this.gameCommand('reparent_node', args, a => ({
			node_path: a.nodePath, new_parent_path: a.newParentPath, keep_global_transform: a.keepGlobalTransform !== false,
		}));
	}

	private async handleAttachScript(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.scenePath || !args.nodePath || !args.scriptPath)
			return createErrorResponse('projectPath, scenePath, nodePath, and scriptPath are required.');
		return this.headlessOp('attach_script', args, a => ({
			projectPath: a.projectPath,
			params: { scenePath: a.scenePath, nodePath: a.nodePath, scriptPath: a.scriptPath },
		}));
	}

	private async handleCreateResource(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.resourceType || !args.resourcePath)
			return createErrorResponse('projectPath, resourceType, and resourcePath are required.');
		return this.headlessOp('create_resource', args, a => ({
			projectPath: a.projectPath,
			params: { resourceType: a.resourceType, resourcePath: a.resourcePath, ...(a.properties ? { properties: a.properties } : {}) },
		}));
	}

	// --- File I/O handlers ---

	private async handleReadFile(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.filePath)
			return createErrorResponse('projectPath and filePath are required.');
		if (!validatePath(args.projectPath) || !validatePath(args.filePath))
			return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile))
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		const fullPath = join(args.projectPath, args.filePath);
		if (!existsSync(fullPath))
			return createErrorResponse(`File does not exist: ${args.filePath}`);
		try {
			const content = readFileSync(fullPath, 'utf8');
			return { content: [{ type: 'text', text: content }] };
		} catch (error: any) {
			return createErrorResponse(`Failed to read file: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleWriteFile(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.filePath || args.content === undefined)
			return createErrorResponse('projectPath, filePath, and content are required.');
		if (!validatePath(args.projectPath) || !validatePath(args.filePath))
			return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile))
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		try {
			const fullPath = join(args.projectPath, args.filePath);
			const parentDir = dirname(fullPath);
			if (!existsSync(parentDir)) {
				mkdirSync(parentDir, { recursive: true });
			}
			writeFileSync(fullPath, args.content, 'utf8');
			return { content: [{ type: 'text', text: `File written: ${args.filePath}` }] };
		} catch (error: any) {
			return createErrorResponse(`Failed to write file: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleDeleteFile(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.filePath)
			return createErrorResponse('projectPath and filePath are required.');
		if (!validatePath(args.projectPath) || !validatePath(args.filePath))
			return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile))
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		const fullPath = join(args.projectPath, args.filePath);
		if (!existsSync(fullPath))
			return createErrorResponse(`File does not exist: ${args.filePath}`);
		try {
			unlinkSync(fullPath);
			return { content: [{ type: 'text', text: `File deleted: ${args.filePath}` }] };
		} catch (error: any) {
			return createErrorResponse(`Failed to delete file: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleCreateDirectory(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.directoryPath)
			return createErrorResponse('projectPath and directoryPath are required.');
		if (!validatePath(args.projectPath) || !validatePath(args.directoryPath))
			return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile))
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		try {
			const fullPath = join(args.projectPath, args.directoryPath);
			mkdirSync(fullPath, { recursive: true });
			return { content: [{ type: 'text', text: `Directory created: ${args.directoryPath}` }] };
		} catch (error: any) {
			return createErrorResponse(`Failed to create directory: ${error?.message || 'Unknown error'}`);
		}
	}

	// --- Error/Log capture handlers ---

	private async handleGameGetErrors() {
		if (!this.activeProcess)
			return createErrorResponse('No active Godot process. Use run_project first.');
		const errors = this.activeProcess.errors.slice(this.lastErrorIndex);
		this.lastErrorIndex = this.activeProcess.errors.length;
		return { content: [{ type: 'text', text: JSON.stringify({ count: errors.length, errors }, null, 2) }] };
	}

	private async handleGameGetLogs() {
		if (!this.activeProcess)
			return createErrorResponse('No active Godot process. Use run_project first.');
		const logs = this.activeProcess.output.slice(this.lastLogIndex);
		this.lastLogIndex = this.activeProcess.output.length;
		return { content: [{ type: 'text', text: JSON.stringify({ count: logs.length, logs }, null, 2) }] };
	}

	// --- Enhanced input handlers ---

	private async handleGameKeyHold(args: any) {
		args = args || {};
		if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
		const params: Record<string, any> = {};
		if (args.key) params.key = args.key;
		if (args.action) params.action = args.action;
		return this.gameCommand('key_hold', args, () => params);
	}

	private async handleGameKeyRelease(args: any) {
		args = args || {};
		if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
		const params: Record<string, any> = {};
		if (args.key) params.key = args.key;
		if (args.action) params.action = args.action;
		return this.gameCommand('key_release', args, () => params);
	}

	private async handleGameScroll(args: any) {
		return this.gameCommand('scroll', args, a => ({
			x: a.x ?? 0, y: a.y ?? 0, direction: a.direction || 'up', amount: a.amount || 1,
		}));
	}

	private async handleGameMouseDrag(args: any) {
		args = normalizeParameters(args || {});
		if (args.fromX === undefined || args.fromY === undefined || args.toX === undefined || args.toY === undefined)
			return createErrorResponse('fromX, fromY, toX, and toY are required.');
		return this.gameCommand('mouse_drag', args, a => ({
			from_x: a.fromX, from_y: a.fromY, to_x: a.toX, to_y: a.toY,
			button: a.button || 1, steps: a.steps || 10,
		}), 30000);
	}

	private async handleGameGamepad(args: any) {
		args = normalizeParameters(args || {});
		if (!args.type || args.index === undefined || args.value === undefined)
			return createErrorResponse('type, index, and value are required.');
		return this.gameCommand('gamepad', args, a => ({
			type: a.type, index: a.index, value: a.value, device: a.device || 0,
		}));
	}

	// --- Project management handlers ---

	private async handleCreateProject(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.projectName)
			return createErrorResponse('projectPath and projectName are required.');
		if (!validatePath(args.projectPath))
			return createErrorResponse('Invalid path.');
		try {
			if (!existsSync(args.projectPath)) {
				mkdirSync(args.projectPath, { recursive: true });
			}
			const projectFile = join(args.projectPath, 'project.godot');
			if (existsSync(projectFile))
				return createErrorResponse('A project.godot already exists at this path.');
			const content = `; Engine configuration file.\n; Generated by Godot MCP.\n\nconfig_version=5\n\n[application]\n\nconfig/name="${args.projectName}"\nconfig/features=PackedStringArray("4.3")\n`;
			writeFileSync(projectFile, content, 'utf8');
			return { content: [{ type: 'text', text: `Project "${args.projectName}" created at ${args.projectPath}` }] };
		} catch (error: any) {
			return createErrorResponse(`Failed to create project: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleManageAutoloads(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.action)
			return createErrorResponse('projectPath and action are required.');
		if (!validatePath(args.projectPath))
			return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile))
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		try {
			let content = readFileSync(projectFile, 'utf8');
			if (args.action === 'list') {
				const autoloads: Record<string, string> = {};
				const autoloadMatch = content.match(/\[autoload\]([\s\S]*?)(?=\n\[|$)/);
				if (autoloadMatch) {
					for (const line of autoloadMatch[1].split('\n')) {
						const kv = line.trim().match(/^([^=]+)=(.*)$/);
						if (kv) autoloads[kv[1].trim()] = kv[2].trim();
					}
				}
				return { content: [{ type: 'text', text: JSON.stringify(autoloads, null, 2) }] };
			} else if (args.action === 'add') {
				if (!args.name || !args.path)
					return createErrorResponse('name and path are required for add action.');
				const autoloadLine = `${args.name}="*${args.path}"`;
				if (content.includes('[autoload]')) {
					content = content.replace('[autoload]', `[autoload]\n\n${autoloadLine}`);
				} else {
					content += `\n[autoload]\n\n${autoloadLine}\n`;
				}
				writeFileSync(projectFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Autoload "${args.name}" added: ${args.path}` }] };
			} else if (args.action === 'remove') {
				if (!args.name)
					return createErrorResponse('name is required for remove action.');
				const pattern = new RegExp(`\\n?${args.name}\\s*=.*\\n?`, 'g');
				content = content.replace(pattern, '\n');
				writeFileSync(projectFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Autoload "${args.name}" removed.` }] };
			}
			return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
		} catch (error: any) {
			return createErrorResponse(`Failed to manage autoloads: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleManageInputMap(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.action)
			return createErrorResponse('projectPath and action are required.');
		if (!validatePath(args.projectPath))
			return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile))
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		try {
			let content = readFileSync(projectFile, 'utf8');
			if (args.action === 'list') {
				const actions: Record<string, string> = {};
				const inputMatch = content.match(/\[input\]([\s\S]*?)(?=\n\[|$)/);
				if (inputMatch) {
					for (const line of inputMatch[1].split('\n')) {
						const kv = line.trim().match(/^([^=]+)=(.*)$/);
						if (kv) actions[kv[1].trim()] = kv[2].trim();
					}
				}
				return { content: [{ type: 'text', text: JSON.stringify(actions, null, 2) }] };
			} else if (args.action === 'add') {
				if (!args.actionName)
					return createErrorResponse('actionName is required for add action.');
				const deadzone = args.deadzone !== undefined ? args.deadzone : 0.5;
				let events = '';
				if (args.key) {
					events = `, "events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":${this.keyNameToScancode(args.key)},"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)]`;
				}
				const inputLine = `${args.actionName}={"deadzone": ${deadzone}${events}}`;
				if (content.includes('[input]')) {
					content = content.replace('[input]', `[input]\n\n${inputLine}`);
				} else {
					content += `\n[input]\n\n${inputLine}\n`;
				}
				writeFileSync(projectFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Input action "${args.actionName}" added.` }] };
			} else if (args.action === 'remove') {
				if (!args.actionName)
					return createErrorResponse('actionName is required for remove action.');
				const pattern = new RegExp(`\\n?${args.actionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*\\n?`, 'g');
				content = content.replace(pattern, '\n');
				writeFileSync(projectFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Input action "${args.actionName}" removed.` }] };
			}
			return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
		} catch (error: any) {
			return createErrorResponse(`Failed to manage input map: ${error?.message || 'Unknown error'}`);
		}
	}

	private keyNameToScancode(key: string): number {
		const map: Record<string, number> = {
			'A': 65, 'B': 66, 'C': 67, 'D': 68, 'E': 69, 'F': 70, 'G': 71, 'H': 72,
			'I': 73, 'J': 74, 'K': 75, 'L': 76, 'M': 77, 'N': 78, 'O': 79, 'P': 80,
			'Q': 81, 'R': 82, 'S': 83, 'T': 84, 'U': 85, 'V': 86, 'W': 87, 'X': 88,
			'Y': 89, 'Z': 90, 'SPACE': 32, 'ENTER': 16777221, 'ESCAPE': 16777217,
			'TAB': 16777218, 'BACKSPACE': 16777220, 'UP': 16777232, 'DOWN': 16777234,
			'LEFT': 16777231, 'RIGHT': 16777233, 'SHIFT': 16777237, 'CTRL': 16777238,
			'ALT': 16777240, 'F1': 16777244, 'F2': 16777245, 'F3': 16777246,
			'F4': 16777247, 'F5': 16777248, 'F6': 16777249, 'F7': 16777250,
			'F8': 16777251, 'F9': 16777252, 'F10': 16777253, 'F11': 16777254,
			'F12': 16777255,
		};
		const upper = key.toUpperCase();
		return map[upper] || (key.length === 1 ? key.charCodeAt(0) : 0);
	}

	private async handleManageExportPresets(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.action)
			return createErrorResponse('projectPath and action are required.');
		if (!validatePath(args.projectPath))
			return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile))
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		const presetsFile = join(args.projectPath, 'export_presets.cfg');
		try {
			if (args.action === 'list') {
				if (!existsSync(presetsFile))
					return { content: [{ type: 'text', text: JSON.stringify({ presets: [] }, null, 2) }] };
				const content = readFileSync(presetsFile, 'utf8');
				const presets: Array<{ name: string; platform: string }> = [];
				const nameMatches = content.matchAll(/name="([^"]+)"/g);
				const platformMatches = content.matchAll(/platform="([^"]+)"/g);
				const names = [...nameMatches].map(m => m[1]);
				const platforms = [...platformMatches].map(m => m[1]);
				for (let i = 0; i < names.length; i++) {
					presets.push({ name: names[i], platform: platforms[i] || 'unknown' });
				}
				return { content: [{ type: 'text', text: JSON.stringify({ presets }, null, 2) }] };
			} else if (args.action === 'add') {
				if (!args.name || !args.platform)
					return createErrorResponse('name and platform are required for add action.');
				const runnable = args.runnable ? 'true' : 'false';
				const presetBlock = `\n[preset.${Date.now()}]\n\nname="${args.name}"\nplatform="${args.platform}"\nrunnable=${runnable}\n`;
				let content = existsSync(presetsFile) ? readFileSync(presetsFile, 'utf8') : '';
				content += presetBlock;
				writeFileSync(presetsFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Export preset "${args.name}" added for platform "${args.platform}".` }] };
			} else if (args.action === 'remove') {
				if (!args.name)
					return createErrorResponse('name is required for remove action.');
				if (!existsSync(presetsFile))
					return createErrorResponse('No export_presets.cfg file found.');
				let content = readFileSync(presetsFile, 'utf8');
				// Remove the preset section containing the given name
				const pattern = new RegExp(`\\[preset\\.[^\\]]+\\]\\s*\\n[\\s\\S]*?name="${args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?(?=\\[preset\\.|$)`, 'g');
				content = content.replace(pattern, '');
				writeFileSync(presetsFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Export preset "${args.name}" removed.` }] };
			}
			return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
		} catch (error: any) {
			return createErrorResponse(`Failed to manage export presets: ${error?.message || 'Unknown error'}`);
		}
	}

	// --- Advanced runtime handlers ---

	private async handleGameGetCamera() {
		return this.gameCommand('get_camera', {}, () => ({}));
	}

	private async handleGameSetCamera(args: any) {
		return this.gameCommand('set_camera', args, a => ({
			...(a.position ? { position: a.position } : {}),
			...(a.rotation ? { rotation: a.rotation } : {}),
			...(a.zoom ? { zoom: a.zoom } : {}),
			...(a.fov !== undefined ? { fov: a.fov } : {}),
		}));
	}

	private async handleGameRaycast(args: any) {
		args = normalizeParameters(args || {});
		if (!args.from || !args.to)
			return createErrorResponse('from and to are required.');
		return this.gameCommand('raycast', args, a => ({
			from: a.from, to: a.to, collision_mask: a.collisionMask ?? 0xFFFFFFFF,
		}));
	}

	private async handleGameGetAudio() {
		return this.gameCommand('get_audio', {}, () => ({}));
	}

	private async handleGameSpawnNode(args: any) {
		args = normalizeParameters(args || {});
		if (!args.type)
			return createErrorResponse('type is required.');
		return this.gameCommand('spawn_node', args, a => ({
			type: a.type, name: a.name || '', parent_path: a.parentPath || '/root',
			...(a.properties ? { properties: a.properties } : {}),
		}));
	}

	private async handleGameSetShaderParam(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.paramName)
			return createErrorResponse('nodePath and paramName are required.');
		return this.gameCommand('set_shader_param', args, a => ({
			node_path: a.nodePath, param_name: a.paramName, value: a.value,
			...(a.typeHint ? { type_hint: a.typeHint } : {}),
		}));
	}

	private async handleGameAudioPlay(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath)
			return createErrorResponse('nodePath is required.');
		return this.gameCommand('audio_play', args, a => ({
			node_path: a.nodePath, action: a.action || 'play',
			...(a.stream ? { stream: a.stream } : {}),
			...(a.volume !== undefined ? { volume: a.volume } : {}),
			...(a.pitch !== undefined ? { pitch: a.pitch } : {}),
			...(a.bus ? { bus: a.bus } : {}),
			...(a.fromPosition !== undefined ? { from_position: a.fromPosition } : {}),
		}));
	}

	private async handleGameAudioBus(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (['set_volume', 'mute', 'solo'].includes(action)) {
			return this.gameCommand('audio_bus', args, a => ({
				bus_name: a.busName || 'Master',
				...(a.volume !== undefined ? { volume: a.volume } : {}),
				...(a.mute !== undefined ? { mute: a.mute } : {}),
				...(a.solo !== undefined ? { solo: a.solo } : {}),
			}));
		}
		
		// Añadido soporte para efectos
		if (['add_effect', 'remove_effect', 'configure_effect'].includes(action)) {
			return await this.handleGameAudioEffect(args);
		}
		
		return createErrorResponse(`Unknown audio bus action: ${action}`);
	}

	private async handleGameNavigatePath(args: any) {
		args = normalizeParameters(args || {});
		if (!args.start || !args.end)
			return createErrorResponse('start and end are required.');
		return this.gameCommand('navigate_path', args, a => ({
			start: a.start, end: a.end, optimize: a.optimize ?? true,
		}));
	}

	private async handleGameTilemap(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath)
			return createErrorResponse('nodePath is required.');
		if (!args.action)
			return createErrorResponse('action is required.');
		return this.gameCommand('tilemap', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.x !== undefined ? { x: a.x } : {}),
			...(a.y !== undefined ? { y: a.y } : {}),
			...(a.cells ? { cells: a.cells } : {}),
			...(a.sourceId !== undefined ? { source_id: a.sourceId } : {}),
		}));
	}

	private async handleGameAddCollision(args: any) {
		args = normalizeParameters(args || {});
		if (!args.parentPath || !args.shapeType)
			return createErrorResponse('parentPath and shapeType are required.');
		return this.gameCommand('add_collision', args, a => ({
			parent_path: a.parentPath, shape_type: a.shapeType,
			...(a.shapeParams ? { shape_params: a.shapeParams } : {}),
			...(a.collisionLayer !== undefined ? { collision_layer: a.collisionLayer } : {}),
			...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
			...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
		}));
	}

	private async handleGameEnvironment(args: any) {
		args = normalizeParameters(args || {});
		const params: Record<string, any> = { action: args.action || 'set' };
		// Pass through all environment settings
		const envKeys = [
			'backgroundMode', 'backgroundColor', 'ambientLightColor', 'ambientLightEnergy',
			'fogEnabled', 'fogDensity', 'fogLightColor',
			'glowEnabled', 'glowIntensity', 'glowBloom',
			'tonemapMode', 'ssaoEnabled', 'ssaoRadius', 'ssaoIntensity', 'ssrEnabled',
			'brightness', 'contrast', 'saturation',
		];
		const snakeMap: Record<string, string> = {
			backgroundMode: 'background_mode', backgroundColor: 'background_color',
			ambientLightColor: 'ambient_light_color', ambientLightEnergy: 'ambient_light_energy',
			fogEnabled: 'fog_enabled', fogDensity: 'fog_density', fogLightColor: 'fog_light_color',
			glowEnabled: 'glow_enabled', glowIntensity: 'glow_intensity', glowBloom: 'glow_bloom',
			tonemapMode: 'tonemap_mode', ssaoEnabled: 'ssao_enabled', ssaoRadius: 'ssao_radius',
			ssaoIntensity: 'ssao_intensity', ssrEnabled: 'ssr_enabled',
			brightness: 'brightness', contrast: 'contrast', saturation: 'saturation',
		};
		for (const key of envKeys) {
			if (args[key] !== undefined) {
				params[snakeMap[key]] = args[key];
			}
		}
		return this.gameCommand('environment', { ...args }, () => params);
	}

	private async handleGameManageGroup(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action)
			return createErrorResponse('action is required.');
		return this.gameCommand('manage_group', args, a => ({
			action: a.action,
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.group ? { group: a.group } : {}),
		}));
	}

	private async handleGameCreateTimer(args: any) {
		return this.gameCommand('create_timer', args, a => ({
			parent_path: a.parentPath || '/root',
			wait_time: a.waitTime ?? 1.0,
			one_shot: a.oneShot ?? false,
			autostart: a.autostart ?? false,
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameSetParticles(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath)
			return createErrorResponse('nodePath is required.');
		return this.gameCommand('set_particles', args, a => ({
			node_path: a.nodePath,
			...(a.emitting !== undefined ? { emitting: a.emitting } : {}),
			...(a.amount !== undefined ? { amount: a.amount } : {}),
			...(a.lifetime !== undefined ? { lifetime: a.lifetime } : {}),
			...(a.oneShot !== undefined ? { one_shot: a.oneShot } : {}),
			...(a.speedScale !== undefined ? { speed_scale: a.speedScale } : {}),
			...(a.explosiveness !== undefined ? { explosiveness: a.explosiveness } : {}),
			...(a.randomness !== undefined ? { randomness: a.randomness } : {}),
			...(a.processMaterial ? { process_material: a.processMaterial } : {}),
		}));
	}

	private async handleGameCreateAnimation(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.animationName)
			return createErrorResponse('nodePath and animationName are required.');
		return this.gameCommand('create_animation', args, a => ({
			node_path: a.nodePath,
			animation_name: a.animationName,
			length: a.length ?? 1.0,
			loop_mode: a.loopMode ?? 0,
			tracks: a.tracks || [],
			...(a.library !== undefined ? { library: a.library } : {}),
		}));
	}

	private async handleExportProject(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.presetName || !args.outputPath)
			return createErrorResponse('projectPath, presetName, and outputPath are required.');
		if (!validatePath(args.projectPath))
			return createErrorResponse('Invalid project path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile))
			return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		if (!this.godotPath) {
			await this.detectGodotPath();
			if (!this.godotPath) return createErrorResponse('Could not find Godot executable.');
		}
		try {
			const exportFlag = args.debug ? '--export-debug' : '--export-release';
			const exportArgs = ['--headless', '--path', args.projectPath, exportFlag, args.presetName, args.outputPath];
			const { stdout, stderr } = await execFileAsync(this.godotPath!, exportArgs, { timeout: 120000 });
			if (stderr && stderr.includes('ERROR'))
				return createErrorResponse(`Export failed: ${stderr}`);
			return { content: [{ type: 'text', text: `Export succeeded.\n\nOutput: ${stdout || args.outputPath}` }] };
		} catch (error: any) {
			return createErrorResponse(`Export failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleGameSerializeState(args: any) {
		args = normalizeParameters(args || {});
		return this.gameCommand('serialize_state', args, a => ({
			node_path: a.nodePath || '/root',
			action: a.action || 'save',
			max_depth: a.maxDepth ?? 5,
			...(a.data ? { data: a.data } : {}),
		}));
	}

	private async handleGameCreateJoint(args: any) {
		args = normalizeParameters(args || {});
		if (!args.parentPath || !args.jointType)
			return createErrorResponse('parentPath and jointType are required.');
		return this.gameCommand('create_joint', args, a => ({
			parent_path: a.parentPath,
			joint_type: a.jointType,
			...(a.nodeAPath ? { node_a_path: a.nodeAPath } : {}),
			...(a.nodeBPath ? { node_b_path: a.nodeBPath } : {}),
			...(a.stiffness !== undefined ? { stiffness: a.stiffness } : {}),
			...(a.damping !== undefined ? { damping: a.damping } : {}),
			...(a.length !== undefined ? { length: a.length } : {}),
			...(a.restLength !== undefined ? { rest_length: a.restLength } : {}),
			...(a.softness !== undefined ? { softness: a.softness } : {}),
			...(a.initialOffset !== undefined ? { initial_offset: a.initialOffset } : {}),
		}));
	}

	private async handleGameBonePose(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath)
			return createErrorResponse('nodePath is required.');
		return this.gameCommand('bone_pose', args, a => ({
			node_path: a.nodePath,
			action: a.action || 'list',
			...(a.boneIndex !== undefined ? { bone_index: a.boneIndex } : {}),
			...(a.boneName ? { bone_name: a.boneName } : {}),
			...(a.position ? { position: a.position } : {}),
			...(a.rotation ? { rotation: a.rotation } : {}),
			...(a.scale ? { scale: a.scale } : {}),
		}));
	}

	private async handleGameUiTheme(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.overrides)
			return createErrorResponse('nodePath and overrides are required.');
		return this.gameCommand('ui_theme', args, a => ({
			node_path: a.nodePath,
			overrides: a.overrides,
		}));
	}

	private async handleGameViewport(args: any) {
		args = normalizeParameters(args || {});
		return this.gameCommand('viewport', args, a => ({
			action: a.action || 'create',
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.width !== undefined ? { width: a.width } : {}),
			...(a.height !== undefined ? { height: a.height } : {}),
			...(a.msaa !== undefined ? { msaa: a.msaa } : {}),
			...(a.transparentBg !== undefined ? { transparent_bg: a.transparentBg } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameDebugDraw(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action)
			return createErrorResponse('action is required.');
		return this.gameCommand('debug_draw', args, a => ({
			action: a.action,
			...(a.from ? { from: a.from } : {}),
			...(a.to ? { to: a.to } : {}),
			...(a.center ? { center: a.center } : {}),
			...(a.radius !== undefined ? { radius: a.radius } : {}),
			...(a.size ? { size: a.size } : {}),
			...(a.color ? { color: a.color } : {}),
			...(a.duration !== undefined ? { duration: a.duration } : {}),
		}));
	}

	// --- Batch 1: Networking + Input + System + Signals + Script ---
	private async handleGameHttpRequest(args: any) {
		args = normalizeParameters(args || {});
		if (!args.url) return createErrorResponse('url is required.');
		return this.gameCommand('http_request', args, a => ({
			url: a.url, method: a.method || 'GET',
			...(a.headers ? { headers: a.headers } : {}),
			...(a.body ? { body: a.body } : {}),
			...(a.timeout !== undefined ? { timeout: a.timeout } : {}),
		}), 35000);
	}

	private async handleGameWebsocket(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('websocket', args, a => ({
			action: a.action,
			...(a.url ? { url: a.url } : {}),
			...(a.message ? { message: a.message } : {}),
		}), 15000);
	}

	private async handleGameMultiplayer(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('multiplayer', args, a => ({
			action: a.action,
			...(a.port !== undefined ? { port: a.port } : {}),
			...(a.address ? { address: a.address } : {}),
			...(a.maxClients !== undefined ? { max_clients: a.maxClients } : {}),
		}));
	}

	private async handleGameRpc(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action || !args.method) return createErrorResponse('nodePath, action, and method are required.');
		return this.gameCommand('rpc', args, a => ({
			node_path: a.nodePath, action: a.action, method: a.method,
			...(a.args ? { args: a.args } : {}),
			...(a.mode ? { mode: a.mode } : {}),
			...(a.sync ? { sync: a.sync } : {}),
			...(a.channel !== undefined ? { channel: a.channel } : {}),
		}));
	}

	private async handleGameTouch(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('touch', args, a => ({
			action: a.action, x: a.x ?? 0, y: a.y ?? 0,
			...(a.index !== undefined ? { index: a.index } : {}),
			...(a.toX !== undefined ? { to_x: a.toX } : {}),
			...(a.toY !== undefined ? { to_y: a.toY } : {}),
			...(a.steps !== undefined ? { steps: a.steps } : {}),
		}), 15000);
	}

	private async handleGameInputState(args: any) {
		args = normalizeParameters(args || {});
		return this.gameCommand('input_state', args, a => ({
			action: a.action || 'query',
			...(a.x !== undefined ? { x: a.x } : {}),
			...(a.y !== undefined ? { y: a.y } : {}),
			...(a.mouseMode ? { mouse_mode: a.mouseMode } : {}),
		}));
	}

	private async handleGameInputAction(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('input_action', args, a => ({
			action: a.action,
			...(a.actionName ? { action_name: a.actionName } : {}),
			...(a.strength !== undefined ? { strength: a.strength } : {}),
			...(a.key ? { key: a.key } : {}),
		}));
	}

	private async handleGameListSignals(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath) return createErrorResponse('nodePath is required.');
		return this.gameCommand('list_signals', args, a => ({ node_path: a.nodePath }));
	}

	private async handleGameAwaitSignal(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.signalName) return createErrorResponse('nodePath and signalName are required.');
		const timeout = (args.timeout || 10) * 1000 + 2000;
		return this.gameCommand('await_signal', args, a => ({
			node_path: a.nodePath, signal_name: a.signalName, timeout: a.timeout || 10,
		}), timeout);
	}

	private async handleGameScript(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('script', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.source ? { source: a.source } : {}),
			...(a.className ? { class_name: a.className } : {}),
		}));
	}

	private async handleGameWindow(args: any) {
		args = normalizeParameters(args || {});
		return this.gameCommand('window', args, a => ({
			action: a.action || 'get',
			...(a.width !== undefined ? { width: a.width } : {}),
			...(a.height !== undefined ? { height: a.height } : {}),
			...(a.fullscreen !== undefined ? { fullscreen: a.fullscreen } : {}),
			...(a.borderless !== undefined ? { borderless: a.borderless } : {}),
			...(a.title ? { title: a.title } : {}),
			...(a.position ? { position: a.position } : {}),
			...(a.vsync !== undefined ? { vsync: a.vsync } : {}),
		}));
	}

	private async handleGameOsInfo(_args: any) {
		return this.gameCommand('os_info', {}, () => ({}));
	}

	private async handleGameTimeScale(args: any) {
		args = normalizeParameters(args || {});
		return this.gameCommand('time_scale', args, a => ({
			action: a.action || 'get',
			...(a.timeScale !== undefined ? { time_scale: a.timeScale } : {}),
		}));
	}

	private async handleGameProcessMode(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.mode) return createErrorResponse('nodePath and mode are required.');
		return this.gameCommand('process_mode', args, a => ({
			node_path: a.nodePath, mode: a.mode,
		}));
	}

	private async handleGameWorldSettings(args: any) {
		args = normalizeParameters(args || {});
		return this.gameCommand('world_settings', args, a => ({
			action: a.action || 'get',
			...(a.gravity !== undefined ? { gravity: a.gravity } : {}),
			...(a.gravityDirection ? { gravity_direction: a.gravityDirection } : {}),
			...(a.physicsFps !== undefined ? { physics_fps: a.physicsFps } : {}),
		}));
	}

	// --- Batch 2: 3D Rendering + Lighting + Sky + Physics ---
	private async handleGameCsg(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('csg', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.csgType ? { csg_type: a.csgType } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.operation ? { operation: a.operation } : {}),
			...(a.size ? { size: a.size } : {}),
			...(a.radius !== undefined ? { radius: a.radius } : {}),
			...(a.height !== undefined ? { height: a.height } : {}),
			...(a.material ? { material: a.material } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameMultimesh(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('multimesh', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.meshType ? { mesh_type: a.meshType } : {}),
			...(a.count !== undefined ? { count: a.count } : {}),
			...(a.index !== undefined ? { index: a.index } : {}),
			...(a.transform ? { transform: a.transform } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameProceduralMesh(args: any) {
		args = normalizeParameters(args || {});
		if (!args.parentPath || !args.vertices) return createErrorResponse('parentPath and vertices are required.');
		return this.gameCommand('procedural_mesh', args, a => ({
			parent_path: a.parentPath, vertices: a.vertices,
			...(a.normals ? { normals: a.normals } : {}),
			...(a.uvs ? { uvs: a.uvs } : {}),
			...(a.indices ? { indices: a.indices } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameLight3d(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('light_3d', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.lightType ? { light_type: a.lightType } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.color ? { color: a.color } : {}),
			...(a.energy !== undefined ? { energy: a.energy } : {}),
			...(a.range !== undefined ? { range: a.range } : {}),
			...(a.shadows !== undefined ? { shadows: a.shadows } : {}),
			...(a.spotAngle !== undefined ? { spot_angle: a.spotAngle } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameMeshInstance(args: any) {
		args = normalizeParameters(args || {});
		if (!args.parentPath || !args.meshType) return createErrorResponse('parentPath and meshType are required.');
		return this.gameCommand('mesh_instance', args, a => ({
			parent_path: a.parentPath, mesh_type: a.meshType,
			...(a.size ? { size: a.size } : {}),
			...(a.radius !== undefined ? { radius: a.radius } : {}),
			...(a.height !== undefined ? { height: a.height } : {}),
			...(a.material ? { material: a.material } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameGridmap(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('gridmap', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.x !== undefined ? { x: a.x } : {}),
			...(a.y !== undefined ? { y: a.y } : {}),
			...(a.z !== undefined ? { z: a.z } : {}),
			...(a.item !== undefined ? { item: a.item } : {}),
			...(a.orientation !== undefined ? { orientation: a.orientation } : {}),
		}));
	}

	private async handleGame3dEffects(args: any) {
		args = normalizeParameters(args || {});
		if (!args.parentPath || !args.effectType) return createErrorResponse('parentPath and effectType are required.');
		return this.gameCommand('3d_effects', args, a => ({
			parent_path: a.parentPath, effect_type: a.effectType,
			...(a.size ? { size: a.size } : {}),
			...(a.intensity !== undefined ? { intensity: a.intensity } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameGi(args: any) {
		args = normalizeParameters(args || {});
		if (!args.parentPath || !args.giType) return createErrorResponse('parentPath and giType are required.');
		return this.gameCommand('gi', args, a => ({
			parent_path: a.parentPath, gi_type: a.giType,
			...(a.size ? { size: a.size } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGamePath3d(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('path_3d', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.points ? { points: a.points } : {}),
			...(a.point ? { point: a.point } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameSky(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('sky', args, a => ({
			action: a.action,
			...(a.skyType ? { sky_type: a.skyType } : {}),
			...(a.topColor ? { top_color: a.topColor } : {}),
			...(a.bottomColor ? { bottom_color: a.bottomColor } : {}),
			...(a.sunEnergy !== undefined ? { sun_energy: a.sunEnergy } : {}),
			...(a.groundColor ? { ground_color: a.groundColor } : {}),
		}));
	}

	private async handleGameCameraAttributes(args: any) {
		args = normalizeParameters(args || {});
		return this.gameCommand('camera_attributes', args, a => ({
			action: a.action || 'get',
			...(a.dofBlurFar !== undefined ? { dof_blur_far: a.dofBlurFar } : {}),
			...(a.dofBlurNear !== undefined ? { dof_blur_near: a.dofBlurNear } : {}),
			...(a.dofBlurAmount !== undefined ? { dof_blur_amount: a.dofBlurAmount } : {}),
			...(a.exposureMultiplier !== undefined ? { exposure_multiplier: a.exposureMultiplier } : {}),
			...(a.autoExposure !== undefined ? { auto_exposure: a.autoExposure } : {}),
			...(a.autoExposureScale !== undefined ? { auto_exposure_scale: a.autoExposureScale } : {}),
		}));
	}

	private async handleGameNavigation3d(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('navigation_3d', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.cellSize !== undefined ? { cell_size: a.cellSize } : {}),
			...(a.agentRadius !== undefined ? { agent_radius: a.agentRadius } : {}),
			...(a.agentHeight !== undefined ? { agent_height: a.agentHeight } : {}),
			...(a.name ? { name: a.name } : {}),
		}), 30000);
	}

	private async handleGamePhysics3d(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('physics_3d', args, a => ({
			action: a.action,
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.from ? { from: a.from } : {}),
			...(a.to ? { to: a.to } : {}),
			...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
		}), 15000);
	}

	// --- Batch 3: 2D Systems + Animation Advanced + Audio Effects ---
	private async handleGameCanvas(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('canvas', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.layer !== undefined ? { layer: a.layer } : {}),
			...(a.color ? { color: a.color } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameCanvasDraw(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('canvas_draw', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.from ? { from: a.from } : {}),
			...(a.to ? { to: a.to } : {}),
			...(a.center ? { center: a.center } : {}),
			...(a.radius !== undefined ? { radius: a.radius } : {}),
			...(a.rect ? { rect: a.rect } : {}),
			...(a.points ? { points: a.points } : {}),
			...(a.text ? { text: a.text } : {}),
			...(a.color ? { color: a.color } : {}),
			...(a.width !== undefined ? { width: a.width } : {}),
			...(a.filled !== undefined ? { filled: a.filled } : {}),
		}));
	}

	private async handleGameLight2d(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('light_2d', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.color ? { color: a.color } : {}),
			...(a.energy !== undefined ? { energy: a.energy } : {}),
			...(a.range !== undefined ? { range: a.range } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameParallax(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('parallax', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.motionScale ? { motion_scale: a.motionScale } : {}),
			...(a.motionOffset ? { motion_offset: a.motionOffset } : {}),
			...(a.mirroring ? { mirroring: a.mirroring } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameShape2d(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('shape_2d', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.points ? { points: a.points } : {}),
			...(a.point ? { point: a.point } : {}),
			...(a.width !== undefined ? { width: a.width } : {}),
			...(a.color ? { color: a.color } : {}),
		}));
	}

	private async handleGamePath2d(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('path_2d', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.points ? { points: a.points } : {}),
			...(a.point ? { point: a.point } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGamePhysics2d(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('physics_2d', args, a => ({
			action: a.action,
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.from ? { from: a.from } : {}),
			...(a.to ? { to: a.to } : {}),
			...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
		}), 15000);
	}

	private async handleGameAnimationTree(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('animation_tree', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.stateName ? { state_name: a.stateName } : {}),
			...(a.paramName ? { param_name: a.paramName } : {}),
			...(a.paramValue !== undefined ? { param_value: a.paramValue } : {}),
		}));
	}

	private async handleGameAnimationControl(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('animation_control', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.animationName ? { animation_name: a.animationName } : {}),
			...(a.position !== undefined ? { position: a.position } : {}),
			...(a.speed !== undefined ? { speed: a.speed } : {}),
		}));
	}

	private async handleGameSkeletonIk(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('skeleton_ik', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.target ? { target: a.target } : {}),
		}));
	}

	private async handleGameAudioEffect(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('audio_effect', args, a => ({
			action: a.action, bus_name: a.busName || 'Master',
			...(a.effectType ? { effect_type: a.effectType } : {}),
			...(a.index !== undefined ? { index: a.index } : {}),
			...(a.properties ? { properties: a.properties } : {}),
		}));
	}

	private async handleGameAudioBusLayout(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('audio_bus_layout', args, a => ({
			action: a.action,
			...(a.busName ? { bus_name: a.busName } : {}),
			...(a.sendTo ? { send_to: a.sendTo } : {}),
			...(a.index !== undefined ? { index: a.index } : {}),
		}));
	}

	private async handleGameAudioSpatial(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('audio_spatial', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.maxDistance !== undefined ? { max_distance: a.maxDistance } : {}),
			...(a.unitSize !== undefined ? { unit_size: a.unitSize } : {}),
			...(a.maxDb !== undefined ? { max_db: a.maxDb } : {}),
			...(a.attenuationModel ? { attenuation_model: a.attenuationModel } : {}),
		}));
	}

	// --- Batch 4: Editor/Headless + Localization + Resource ---
	private async handleRenameFile(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.filePath || !args.newPath) return createErrorResponse('projectPath, filePath, and newPath are required.');
		if (!validatePath(args.projectPath) || !validatePath(args.filePath) || !validatePath(args.newPath)) return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		const srcFull = join(args.projectPath, args.filePath);
		const dstFull = join(args.projectPath, args.newPath);
		if (!existsSync(srcFull)) return createErrorResponse(`File not found: ${args.filePath}`);
		try {
			const dstDir = dirname(dstFull);
			if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
			renameSync(srcFull, dstFull);
			return { content: [{ type: 'text', text: `Renamed ${args.filePath} → ${args.newPath}` }] };
		} catch (error: any) {
			return createErrorResponse(`rename_file failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleManageResource(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.resourcePath || !args.action) return createErrorResponse('projectPath, resourcePath, and action are required.');
		return this.headlessOp('manage_resource', args, a => ({
			projectPath: a.projectPath,
			params: { resourcePath: a.resourcePath, action: a.action, ...(a.properties ? { properties: a.properties } : {}) },
		}));
	}

	private async handleCreateScript(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.scriptPath) return createErrorResponse('projectPath and scriptPath are required.');
		if (!validatePath(args.projectPath) || !validatePath(args.scriptPath)) return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		try {
			const fullPath = join(args.projectPath, args.scriptPath);
			const dir = dirname(fullPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			let source = args.source;
			if (!source) {
				const ext = args.extends || 'Node';
				const lines = [`extends ${ext}`, ''];
				if (args.className) lines.splice(1, 0, `class_name ${args.className}`);
				if (args.methods && Array.isArray(args.methods)) {
					for (const m of args.methods) {
						lines.push('', `func ${m}():`);
						lines.push('\tpass');
					}
				}
				source = lines.join('\n') + '\n';
			}
			writeFileSync(fullPath, source, 'utf8');
			return { content: [{ type: 'text', text: `Script created at ${args.scriptPath}` }] };
		} catch (error: any) {
			return createErrorResponse(`create_script failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleManageSceneSignals(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.scenePath || !args.action) return createErrorResponse('projectPath, scenePath, and action are required.');
		return this.headlessOp('manage_scene_signals', args, a => ({
			projectPath: a.projectPath,
			params: {
				scenePath: a.scenePath, action: a.action,
				...(a.signalName ? { signalName: a.signalName } : {}),
				...(a.sourcePath ? { sourcePath: a.sourcePath } : {}),
				...(a.targetPath ? { targetPath: a.targetPath } : {}),
				...(a.method ? { method: a.method } : {}),
			},
		}));
	}

	private async handleManageLayers(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
		if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		try {
			let content = readFileSync(projectFile, 'utf8');
			if (args.action === 'list') {
				const layerRegex = /layer_names\/([\w_]+)\/layer_(\d+)="([^"]+)"/g;
				const layers: any[] = [];
				let match;
				while ((match = layerRegex.exec(content)) !== null) {
					layers.push({ type: match[1], layer: parseInt(match[2]), name: match[3] });
				}
				return { content: [{ type: 'text', text: JSON.stringify({ layers }, null, 2) }] };
			} else if (args.action === 'set') {
				if (!args.layerType || !args.layer || !args.name) return createErrorResponse('layerType, layer, and name are required for set.');
				const key = `layer_names/${args.layerType}/layer_${args.layer}`;
				const settingLine = `${key}="${args.name}"`;
				const existingRegex = new RegExp(`${key.replace(/\//g, '\\/')}="[^"]*"`);
				if (existingRegex.test(content)) {
					content = content.replace(existingRegex, settingLine);
				} else {
					if (!content.includes('[layer_names]')) content += '\n[layer_names]\n';
					content = content.replace('[layer_names]', `[layer_names]\n${settingLine}`);
				}
				writeFileSync(projectFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Layer set: ${settingLine}` }] };
			}
			return createErrorResponse(`Unknown action: ${args.action}`);
		} catch (error: any) {
			return createErrorResponse(`manage_layers failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleManagePlugins(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
		if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		try {
			let content = readFileSync(projectFile, 'utf8');
			if (args.action === 'list') {
				const pluginRegex = /(\w+)\/enabled=true/g;
				const plugins: string[] = [];
				let match;
				while ((match = pluginRegex.exec(content)) !== null) {
					plugins.push(match[1]);
				}
				const addonsDir = join(args.projectPath, 'addons');
				const available: string[] = [];
				if (existsSync(addonsDir)) {
					const entries = readdirSync(addonsDir, { withFileTypes: true });
					for (const e of entries) {
						if (e.isDirectory()) available.push(e.name);
					}
				}
				return { content: [{ type: 'text', text: JSON.stringify({ enabled: plugins, available }, null, 2) }] };
			} else if (args.action === 'enable' || args.action === 'disable') {
				if (!args.pluginName) return createErrorResponse('pluginName is required.');
				const key = `${args.pluginName}/enabled`;
				const val = args.action === 'enable' ? 'true' : 'false';
				const existingRegex = new RegExp(`${args.pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/enabled=\\w+`);
				if (existingRegex.test(content)) {
					content = content.replace(existingRegex, `${key}=${val}`);
				} else {
					if (!content.includes('[editor_plugins]')) content += '\n[editor_plugins]\n';
					content = content.replace('[editor_plugins]', `[editor_plugins]\n${key}=${val}`);
				}
				writeFileSync(projectFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Plugin ${args.pluginName} ${args.action}d.` }] };
			}
			return createErrorResponse(`Unknown action: ${args.action}`);
		} catch (error: any) {
			return createErrorResponse(`manage_plugins failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleManageShader(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.shaderPath || !args.action) return createErrorResponse('projectPath, shaderPath, and action are required.');
		if (!validatePath(args.projectPath) || !validatePath(args.shaderPath)) return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		const fullPath = join(args.projectPath, args.shaderPath);
		try {
			if (args.action === 'read') {
				if (!existsSync(fullPath)) return createErrorResponse(`Shader not found: ${args.shaderPath}`);
				const source = readFileSync(fullPath, 'utf8');
				return { content: [{ type: 'text', text: source }] };
			} else if (args.action === 'create') {
				const dir = dirname(fullPath);
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				let source = args.source;
				if (!source) {
					const type = args.shaderType || 'spatial';
					source = `shader_type ${type};\n\nvoid fragment() {\n\t// Called for every pixel the material is visible on.\n}\n`;
				}
				writeFileSync(fullPath, source, 'utf8');
				return { content: [{ type: 'text', text: `Shader created at ${args.shaderPath}` }] };
			}
			return createErrorResponse(`Unknown action: ${args.action}`);
		} catch (error: any) {
			return createErrorResponse(`manage_shader failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleManageThemeResource(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.resourcePath || !args.action) return createErrorResponse('projectPath, resourcePath, and action are required.');
		return this.headlessOp('manage_theme_resource', args, a => ({
			projectPath: a.projectPath,
			params: { resourcePath: a.resourcePath, action: a.action, ...(a.properties ? { properties: a.properties } : {}) },
		}));
	}

	private async handleSetMainScene(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.scenePath) return createErrorResponse('projectPath and scenePath are required.');
		if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		try {
			let content = readFileSync(projectFile, 'utf8');
			const resPath = args.scenePath.startsWith('res://') ? args.scenePath : `res://${args.scenePath}`;
			const settingLine = `run/main_scene="${resPath}"`;
			const existingRegex = /run\/main_scene="[^"]*"/;
			if (existingRegex.test(content)) {
				content = content.replace(existingRegex, settingLine);
			} else {
				if (content.includes('[application]')) {
					content = content.replace('[application]', `[application]\n\n${settingLine}`);
				} else {
					content += `\n[application]\n\n${settingLine}\n`;
				}
			}
			writeFileSync(projectFile, content, 'utf8');
			return { content: [{ type: 'text', text: `Main scene set to ${resPath}` }] };
		} catch (error: any) {
			return createErrorResponse(`set_main_scene failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleManageSceneStructure(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.scenePath || !args.action || !args.nodePath)
			return createErrorResponse('projectPath, scenePath, action, and nodePath are required.');
		return this.headlessOp('manage_scene_structure', args, a => ({
			projectPath: a.projectPath,
			params: {
				scenePath: a.scenePath, action: a.action, nodePath: a.nodePath,
				...(a.newName ? { newName: a.newName } : {}),
				...(a.newParentPath ? { newParentPath: a.newParentPath } : {}),
			},
		}));
	}

	private async handleManageTranslations(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
		if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		try {
			let content = readFileSync(projectFile, 'utf8');
			if (args.action === 'list') {
				const match = content.match(/translations=PackedStringArray\(([^)]*)\)/);
				const translations = match ? match[1].split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean) : [];
				return { content: [{ type: 'text', text: JSON.stringify({ translations }, null, 2) }] };
			} else if (args.action === 'add') {
				if (!args.translationPath) return createErrorResponse('translationPath is required.');
				const resPath = args.translationPath.startsWith('res://') ? args.translationPath : `res://${args.translationPath}`;
				const match = content.match(/translations=PackedStringArray\(([^)]*)\)/);
				if (match) {
					const existing = match[1];
					const newVal = existing ? `${existing}, "${resPath}"` : `"${resPath}"`;
					content = content.replace(/translations=PackedStringArray\([^)]*\)/, `translations=PackedStringArray(${newVal})`);
				} else {
					if (!content.includes('[internationalization]')) content += '\n[internationalization]\n';
					content = content.replace('[internationalization]', `[internationalization]\n\ntranslations=PackedStringArray("${resPath}")`);
				}
				writeFileSync(projectFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Translation added: ${resPath}` }] };
			} else if (args.action === 'remove') {
				if (!args.translationPath) return createErrorResponse('translationPath is required.');
				const resPath = args.translationPath.startsWith('res://') ? args.translationPath : `res://${args.translationPath}`;
				content = content.replace(new RegExp(`,?\\s*"${resPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), '');
				writeFileSync(projectFile, content, 'utf8');
				return { content: [{ type: 'text', text: `Translation removed: ${resPath}` }] };
			}
			return createErrorResponse(`Unknown action: ${args.action}`);
		} catch (error: any) {
			return createErrorResponse(`manage_translations failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleGameLocale(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('locale', args, a => ({
			action: a.action,
			...(a.locale ? { locale: a.locale } : {}),
			...(a.key ? { key: a.key } : {}),
		}));
	}

	// --- Batch 5: UI Controls + Rendering + Resource Runtime ---
	private async handleGameUiControl(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		// Acciones de control genérico
		if (['configure', 'grab_focus'].includes(action)) {
			return this.gameCommand('ui_control', args, a => ({
				node_path: a.nodePath,
				action: a.action,
				...(a.anchorPreset !== undefined ? { anchor_preset: a.anchorPreset } : {}),
				...(a.tooltip ? { tooltip: a.tooltip } : {}),
			}));
		}
		
		// Ruteo a manejadores específicos existentes
		if (action === 'set_text' || action === 'get_text') {
			return await this.handleGameUiText(args);
		}
		
		if (action === 'popup') {
			return await this.handleGameUiPopup(args);
		}
		
		if (action === 'set_value') {
			return await this.handleGameUiRange(args);
		}
		
		if (action === 'select_item') {
			// Reutiliza el manejador de listas/contenedores
			return await this.handleGameUiItemList(args);
		}
		
		return createErrorResponse(`Unknown UI control action: ${action}`);
	}

	private async handleGameUiText(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('ui_text', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.text !== undefined ? { text: a.text } : {}),
			...(a.caretPosition !== undefined ? { caret_position: a.caretPosition } : {}),
			...(a.selectionFrom !== undefined ? { selection_from: a.selectionFrom } : {}),
			...(a.selectionTo !== undefined ? { selection_to: a.selectionTo } : {}),
		}));
	}

	private async handleGameUiPopup(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('ui_popup', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.size ? { size: a.size } : {}),
			...(a.title ? { title: a.title } : {}),
			...(a.text ? { text: a.text } : {}),
		}));
	}

	private async handleGameUiTree(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('ui_tree', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.itemPath ? { item_path: a.itemPath } : {}),
			...(a.text ? { text: a.text } : {}),
			...(a.column !== undefined ? { column: a.column } : {}),
		}));
	}

	private async handleGameUiItemList(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('ui_item_list', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.index !== undefined ? { index: a.index } : {}),
			...(a.text ? { text: a.text } : {}),
		}));
	}

	private async handleGameUiTabs(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('ui_tabs', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.index !== undefined ? { index: a.index } : {}),
			...(a.title ? { title: a.title } : {}),
		}));
	}

	private async handleGameUiMenu(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('ui_menu', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.index !== undefined ? { index: a.index } : {}),
			...(a.text ? { text: a.text } : {}),
			...(a.checked !== undefined ? { checked: a.checked } : {}),
			...(a.id !== undefined ? { id: a.id } : {}),
		}));
	}

	private async handleGameUiRange(args: any) {
		args = normalizeParameters(args || {});
		if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
		return this.gameCommand('ui_range', args, a => ({
			node_path: a.nodePath, action: a.action,
			...(a.value !== undefined ? { value: a.value } : {}),
			...(a.minValue !== undefined ? { min_value: a.minValue } : {}),
			...(a.maxValue !== undefined ? { max_value: a.maxValue } : {}),
			...(a.step !== undefined ? { step: a.step } : {}),
			...(a.color ? { color: a.color } : {}),
		}));
	}

	private async handleGameRenderSettings(args: any) {
		args = normalizeParameters(args || {});
		return this.gameCommand('render_settings', args, a => ({
			action: a.action || 'get',
			...(a.msaa2d !== undefined ? { msaa_2d: a.msaa2d } : {}),
			...(a.msaa3d !== undefined ? { msaa_3d: a.msaa3d } : {}),
			...(a.fxaa !== undefined ? { fxaa: a.fxaa } : {}),
			...(a.taa !== undefined ? { taa: a.taa } : {}),
			...(a.scalingMode !== undefined ? { scaling_mode: a.scalingMode } : {}),
			...(a.scalingScale !== undefined ? { scaling_scale: a.scalingScale } : {}),
		}));
	}

	private async handleGameResource(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action || !args.path) return createErrorResponse('action and path are required.');
		return this.gameCommand('resource', args, a => ({
			action: a.action, path: a.path,
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.property ? { property: a.property } : {}),
		}));
	}

	// --- Batch 6: Visual Shader + Terrain + Video + CI/CD ---
	private async handleGameVisualShader(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('visual_shader', args, a => ({
			action: a.action,
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.shaderType ? { shader_type: a.shaderType } : {}),
			...(a.nodeClass ? { node_class: a.nodeClass } : {}),
			...(a.position ? { position: a.position } : {}),
			...(a.fromNode !== undefined ? { from_node: a.fromNode } : {}),
			...(a.fromPort !== undefined ? { from_port: a.fromPort } : {}),
			...(a.toNode !== undefined ? { to_node: a.toNode } : {}),
			...(a.toPort !== undefined ? { to_port: a.toPort } : {}),
			...(a.shaderId !== undefined ? { shader_id: a.shaderId } : {}),
		}));
	}

	private async handleGameTerrain(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('terrain', args, a => ({
			action: a.action,
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.heightData ? { height_data: a.heightData } : {}),
			...(a.width !== undefined ? { width: a.width } : {}),
			...(a.depth !== undefined ? { depth: a.depth } : {}),
			...(a.maxHeight !== undefined ? { max_height: a.maxHeight } : {}),
			...(a.x !== undefined ? { x: a.x } : {}),
			...(a.z !== undefined ? { z: a.z } : {}),
			...(a.radius !== undefined ? { radius: a.radius } : {}),
			...(a.heightDelta !== undefined ? { height_delta: a.heightDelta } : {}),
			...(a.color ? { color: a.color } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleGameVideo(args: any) {
		args = normalizeParameters(args || {});
		if (!args.action) return createErrorResponse('action is required.');
		return this.gameCommand('video', args, a => ({
			action: a.action,
			...(a.nodePath ? { node_path: a.nodePath } : {}),
			...(a.parentPath ? { parent_path: a.parentPath } : {}),
			...(a.videoPath ? { video_path: a.videoPath } : {}),
			...(a.position !== undefined ? { position: a.position } : {}),
			...(a.volume !== undefined ? { volume: a.volume } : {}),
			...(a.loop !== undefined ? { loop: a.loop } : {}),
			...(a.autoplay !== undefined ? { autoplay: a.autoplay } : {}),
			...(a.name ? { name: a.name } : {}),
		}));
	}

	private async handleManageCiPipeline(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
		if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		const workflowDir = join(args.projectPath, '.github', 'workflows');
		const workflowPath = join(workflowDir, 'godot-export.yml');
		try {
			if (args.action === 'read') {
				if (!existsSync(workflowPath)) return createErrorResponse('No workflow file found at .github/workflows/godot-export.yml');
				const content = readFileSync(workflowPath, 'utf8');
				return { content: [{ type: 'text', text: content }] };
			} else if (args.action === 'create') {
				if (!existsSync(workflowDir)) mkdirSync(workflowDir, { recursive: true });
				const godotVersion = args.godotVersion || '4.3-stable';
				const platforms = args.platforms || ['linux'];
				const exportSteps = platforms.map((p: string) => `      - name: Export ${p}\n        run: godot --headless --export-release "${p}" build/${p}/game`).join('\n');
				const workflow = `name: Godot Export\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs:\n  export:\n    runs-on: ubuntu-latest\n    container:\n      image: barichello/godot-ci:${godotVersion}\n    steps:\n      - uses: actions/checkout@v4\n      - name: Setup export templates\n        run: |\n          mkdir -p ~/.local/share/godot/export_templates/${godotVersion}\n          mv /root/.local/share/godot/export_templates/${godotVersion}/* ~/.local/share/godot/export_templates/${godotVersion}/ || true\n${exportSteps}\n      - uses: actions/upload-artifact@v4\n        with:\n          name: game-builds\n          path: build/\n`;
				writeFileSync(workflowPath, workflow, 'utf8');
				return { content: [{ type: 'text', text: `CI pipeline created at .github/workflows/godot-export.yml for platforms: ${platforms.join(', ')}` }] };
			}
			return createErrorResponse(`Unknown action: ${args.action}`);
		} catch (error: any) {
			return createErrorResponse(`manage_ci_pipeline failed: ${error?.message || 'Unknown error'}`);
		}
	}

	private async handleManageDockerExport(args: any) {
		args = normalizeParameters(args || {});
		if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
		if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
		const projectFile = join(args.projectPath, 'project.godot');
		if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
		const dockerfilePath = join(args.projectPath, 'Dockerfile');
		try {
			if (args.action === 'read') {
				if (!existsSync(dockerfilePath)) return createErrorResponse('No Dockerfile found in project root.');
				const content = readFileSync(dockerfilePath, 'utf8');
				return { content: [{ type: 'text', text: content }] };
			} else if (args.action === 'create') {
				const godotVersion = args.godotVersion || '4.3-stable';
				const baseImage = args.baseImage || 'ubuntu:22.04';
				const exportPreset = args.exportPreset || 'Linux/X11';
				const dockerfile = `FROM ${baseImage}\n\nARG GODOT_VERSION=${godotVersion}\n\nRUN apt-get update && apt-get install -y \\\n    wget unzip ca-certificates \\\n    && rm -rf /var/lib/apt/lists/*\n\nRUN wget -q https://github.com/godotengine/godot/releases/download/\${GODOT_VERSION}/Godot_v\${GODOT_VERSION}_linux.x86_64.zip \\\n    && unzip Godot_v\${GODOT_VERSION}_linux.x86_64.zip \\\n    && mv Godot_v\${GODOT_VERSION}_linux.x86_64 /usr/local/bin/godot \\\n    && rm Godot_v\${GODOT_VERSION}_linux.x86_64.zip\n\nRUN wget -q https://github.com/godotengine/godot/releases/download/\${GODOT_VERSION}/Godot_v\${GODOT_VERSION}_export_templates.tpz \\\n    && mkdir -p /root/.local/share/godot/export_templates/\${GODOT_VERSION} \\\n    && unzip Godot_v\${GODOT_VERSION}_export_templates.tpz \\\n    && mv templates/* /root/.local/share/godot/export_templates/\${GODOT_VERSION}/ \\\n    && rm -rf templates Godot_v\${GODOT_VERSION}_export_templates.tpz\n\nWORKDIR /game\nCOPY . .\n\nRUN mkdir -p build\nCMD ["godot", "--headless", "--export-release", "${exportPreset}", "build/game"]\n`;
				writeFileSync(dockerfilePath, dockerfile, 'utf8');
				return { content: [{ type: 'text', text: `Dockerfile created for headless Godot export (preset: ${exportPreset})` }] };
			}
			return createErrorResponse(`Unknown action: ${args.action}`);
		} catch (error: any) {
			return createErrorResponse(`manage_docker_export failed: ${error?.message || 'Unknown error'}`);
		}
	}

	/**
	 * Handle the update_project_uids tool
	 */
	private async handleUpdateProjectUids(args: any) {
		// Normalize parameters to camelCase
		args = normalizeParameters(args);
		
		if (!args.projectPath) {
			return createErrorResponse(
				'Project path is required'
			);
		}

		if (!validatePath(args.projectPath)) {
			return createErrorResponse(
				'Invalid project path'
			);
		}

		try {
			// Ensure godotPath is set
			if (!this.godotPath) {
				await this.detectGodotPath();
				if (!this.godotPath) {
					return createErrorResponse(
						'Could not find a valid Godot executable path'
					);
				}
			}

			// Check if the project directory exists and contains a project.godot file
			const projectFile = join(args.projectPath, 'project.godot');
			if (!existsSync(projectFile)) {
				return createErrorResponse(
					`Not a valid Godot project: ${args.projectPath}`
				);
			}

			// Get Godot version to check if UIDs are supported
			const { stdout: versionOutput } = await execFileAsync(this.godotPath!, ['--version']);
			const version = versionOutput.trim();

			if (!isGodot44OrLater(version)) {
				return createErrorResponse(
					`UIDs are only supported in Godot 4.4 or later. Current version: ${version}`
				);
			}

			// Prepare parameters for the operation (already in camelCase)
			const params = {
				projectPath: args.projectPath,
			};

			// Execute the operation
			const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

			if (stderr && stderr.includes('Failed to')) {
				return createErrorResponse(
					`Failed to update project UIDs: ${stderr}`
				);
			}

			return {
				content: [
					{
						type: 'text',
						text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
					},
				],
			};
		} catch (error: any) {
			return createErrorResponse(
				`Failed to update project UIDs: ${error?.message || 'Unknown error'}`
			);
		}
	}

	// ============================================================
	// CONSOLIDATED TOOL HANDLERS (Routes to original handlers)
	// ============================================================

	private async handleManageScene(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		switch (action) {
			case 'create':
				return await this.handleCreateScene(args);
			case 'read':
				return await this.handleReadScene(args);
			case 'save':
				return await this.handleSaveScene(args);
			case 'add_node':
				return await this.handleAddNode(args);
			case 'modify_node':
				return await this.handleModifySceneNode(args);
			case 'remove_node':
				return await this.handleRemoveSceneNode(args);
			case 'attach_script':
				return await this.handleAttachScript(args);
			default:
				return createErrorResponse(`Unknown scene action: ${action}`);
		}
	}

	private async handleManageFile(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		switch (action) {
			case 'read':
				return await this.handleReadFile(args);
			case 'write':
				return await this.handleWriteFile(args);
			case 'delete':
				return await this.handleDeleteFile(args);
			case 'rename':
				return await this.handleRenameFile(args);
			default:
				return createErrorResponse(`Unknown file action: ${action}`);
		}
	}

	private async handleManageProjectSettings(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (action === 'read') {
			return await this.handleReadProjectSettings(args);
		} else if (action === 'modify') {
			return await this.handleModifyProjectSettings(args);
		}
		return createErrorResponse(`Unknown settings action: ${action}`);
	}

	private async handleGameMouseInput(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		switch (action) {
			case 'click':
				return await this.handleGameClick(args);
			case 'move':
				return await this.handleGameMouseMove(args);
			case 'drag':
				return await this.handleGameMouseDrag(args);
			case 'scroll':
				return await this.handleGameScroll(args);
			default:
				return createErrorResponse(`Unknown mouse action: ${action}`);
		}
	}

	private async handleGameKeyboardInput(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (action === 'gamepad') {
			return await this.handleGameGamepad(args);
		}
		
		if (action === 'key_press') {
			return await this.handleGameKeyPress(args);
		} else if (action === 'key_hold') {
			return await this.handleGameKeyHold(args);
		} else if (action === 'key_release') {
			return await this.handleGameKeyRelease(args);
		}
		
		return createErrorResponse(`Unknown keyboard action: ${action}`);
	}

	private async handleGameGetInfo(args: any) {
		args = normalizeParameters(args || {});
		const { type } = args;
		
		switch (type) {
			case 'scene_tree':
				return await this.handleGameGetSceneTree();
			case 'ui_elements':
				return await this.handleGameGetUi();
			case 'performance':
				return await this.handleGamePerformance();
			case 'logs':
				return await this.handleGameGetLogs();
			case 'errors':
				return await this.handleGameGetErrors();
			case 'camera':
				return await this.handleGameGetCamera();
			default:
				return createErrorResponse(`Unknown info type: ${type}`);
		}
	}

	private async handleGameNodeProperty(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (action === 'get') {
			return await this.handleGameGetProperty(args);
		} else if (action === 'set') {
			return await this.handleGameSetProperty(args);
		}
		return createErrorResponse(`Unknown property action: ${action}`);
	}

	private async handleGameNodeMethod(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		switch (action) {
			case 'call':
				return await this.handleGameCallMethod(args);
			case 'get_info':
				return await this.handleGameGetNodeInfo(args);
			case 'remove':
				return await this.handleGameRemoveNode(args);
			case 'reparent':
				return await this.handleGameReparentNode(args);
			default:
				return createErrorResponse(`Unknown node method action: ${action}`);
		}
	}

	private async handleGameSceneManagement(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		switch (action) {
			case 'change_scene':
				return await this.handleGameChangeScene(args);
			case 'instantiate':
				return await this.handleGameInstantiateScene(args);
			case 'spawn_node':
				return await this.handleGameSpawnNode(args);
			case 'pause':
				return await this.handleGamePause(args);
			default:
				return createErrorResponse(`Unknown scene management action: ${action}`);
		}
	}

	private async handleGameSignal(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		switch (action) {
			case 'connect':
				return await this.handleGameConnectSignal(args);
			case 'disconnect':
				return await this.handleGameDisconnectSignal(args);
			case 'emit':
				return await this.handleGameEmitSignal(args);
			case 'list':
				return await this.handleGameListSignals(args);
			case 'await':
				return await this.handleGameAwaitSignal(args);
			default:
				return createErrorResponse(`Unknown signal action: ${action}`);
		}
	}

	private async handleGameAnimation(args: any) {
		args = normalizeParameters(args || {});
		const { action, nodePath } = args;
		
		if (!nodePath) return createErrorResponse('nodePath is required');
		
		// AnimationPlayer actions
		if (['play', 'stop', 'pause', 'seek', 'queue', 'get_list', 'set_speed'].includes(action)) {
			return await this.handleGamePlayAnimation({ ...args, nodePath, action: action === 'get_list' ? 'get_list' : action });
		}
		
		// AnimationTree actions
		if (['tree_travel', 'tree_set_param', 'tree_get_state', 'tree_get_params'].includes(action)) {
			const treeAction = action.replace('tree_', '');
			return await this.handleGameAnimationTree({ ...args, nodePath, action: treeAction });
		}
		
		return createErrorResponse(`Unknown animation action: ${action}`);
	}

	private async handleGameTween(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (action === 'tween_property') {
			return await this.handleGameTweenProperty(args);
		} else if (action === 'create_animation') {
			return await this.handleGameCreateAnimation(args);
		}
		
		return createErrorResponse(`Unknown tween action: ${action}`);
	}

	private async handleGamePhysicsQuery(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		// Route to 2D or 3D based on parameters
		if (args.from && (args.from.z !== undefined || (args.to && args.to.z !== undefined))) {
			return await this.handleGamePhysics3d(args);
		}
		return await this.handleGamePhysics2d(args);
	}

	private async handleGamePhysicsBody(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		switch (action) {
			case 'configure_body':
				return this.gameCommand('physics_body', args, a => ({
					node_path: a.nodePath,
					...(a.gravityScale !== undefined ? { gravity_scale: a.gravityScale } : {}),
					...(a.mass !== undefined ? { mass: a.mass } : {}),
					...(a.linearVelocity ? { linear_velocity: a.linearVelocity } : {}),
					...(a.freeze !== undefined ? { freeze: a.freeze } : {}),
				}));
			case 'add_collision':
				return await this.handleGameAddCollision(args);
			case 'create_joint':
				return await this.handleGameCreateJoint(args);
			default:
				return createErrorResponse(`Unknown physics body action: ${action}`);
		}
	}

	private async handleGameAudio(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (['play', 'stop', 'pause'].includes(action)) {
			return await this.handleGameAudioPlay({ ...args, action });
		}
		return createErrorResponse(`Unknown audio action: ${action}`);
	}

	private async handleGameUiContainer(args: any) {
		args = normalizeParameters(args || {});
		const { action, nodePath } = args;
		
		if (!nodePath) return createErrorResponse('nodePath is required');
		
		// Simple routing based on node name patterns
		if (nodePath.toLowerCase().includes('tree')) {
			return await this.handleGameUiTree(args);
		}
		if (nodePath.toLowerCase().includes('tab')) {
			return await this.handleGameUiTabs(args);
		}
		
		return await this.handleGameUiItemList(args);
	}

	private async handleGameRendering(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (['get_settings', 'set_msaa', 'set_fxaa', 'set_taa'].includes(action)) {
			return await this.handleGameRenderSettings(args);
		}
		if (action === 'set_environment') {
			return await this.handleGameEnvironment(args);
		}
		// Añadido soporte para Camera Attributes
		if (action === 'set_camera_attributes') {
			return await this.handleGameCameraAttributes(args);
		}
		
		return createErrorResponse(`Unknown rendering action: ${action}`);
	}

	private async handleGameNavigation(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (action === 'path_2d' || action === 'path_3d') {
			return await this.handleGameNavigatePath(args);
		}
		
		// Añadido soporte para Bake Navigation
		if (action === 'bake_navigation') {
			// Asume que bake es para 3D por defecto o usa el nodePath provisto
			return await this.handleGameNavigation3d({ ...args, action: 'bake' });
		}
		
		return createErrorResponse(`Unknown navigation action: ${action}`);
	}

	private async handleGameNetworking(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (action === 'http_request') {
			return await this.handleGameHttpRequest(args);
		}
		
		// Añadido soporte para WebSockets
		if (action.startsWith('websocket_')) {
			return await this.handleGameWebsocket(args);
		}
		
		// Añadido soporte para Multiplayer
		if (['create_server', 'create_client', 'disconnect'].includes(action)) {
			return await this.handleGameMultiplayer(args);
		}
		
		return createErrorResponse(`Unknown networking action: ${action}`);
	}

	private async handleGameSystem(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		switch (action) {
			case 'get_os_info':
				return await this.handleGameOsInfo(args);
			case 'get_time_scale':
			case 'set_time_scale':
				return await this.handleGameTimeScale(args);
			case 'set_window':
				return await this.handleGameWindow(args);
			case 'set_process_mode':
				return await this.handleGameProcessMode(args);
			default:
				return createErrorResponse(`Unknown system action: ${action}`);
		}
	}

	private async handleGameSerialization(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (action === 'save_state') {
			return await this.handleGameSerializeState({ ...args, action: 'save' });
		}
		if (action === 'load_state') {
			return await this.handleGameSerializeState({ ...args, action: 'load' });
		}
		
		return createErrorResponse(`Unknown serialization action: ${action}`);
	}

	private async handleManageCiCd(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (action === 'create_ci_pipeline') {
			return await this.handleManageCiPipeline({ ...args, action: 'create' });
		}
		if (action === 'read_ci_pipeline') {
			return await this.handleManageCiPipeline({ ...args, action: 'read' });
		}
		
		// Añadido soporte para Docker
		if (action === 'create_dockerfile') {
			return await this.handleManageDockerExport({ ...args, action: 'create' });
		}
		if (action === 'read_dockerfile') {
			return await this.handleManageDockerExport({ ...args, action: 'read' });
		}
		
		return createErrorResponse(`Unknown CI/CD action: ${action}`);
	}

	private async handleManageUid(args: any) {
		args = normalizeParameters(args || {});
		const { action } = args;
		
		if (action === 'get_uid') {
			return await this.handleGetUid(args);
		}
		if (action === 'update_project_uids') {
			return await this.handleUpdateProjectUids(args);
		}
		
		return createErrorResponse(`Unknown UID action: ${action}`);
	}

	// ============================================================
	// END CONSOLIDATED HANDLERS
	// ============================================================

	/**
	 * Run the MCP server
	 */
	async run() {
		try {
			// Detect Godot path before starting the server
			await this.detectGodotPath();

			if (!this.godotPath) {
				console.error('[SERVER] Failed to find a valid Godot executable path');
				console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
				process.exit(1);
			}

			// Check if the path is valid
			const isValid = await this.isValidGodotPath(this.godotPath);

			if (!isValid) {
				if (this.strictPathValidation) {
					// In strict mode, exit if the path is invalid
					console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
					console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
					process.exit(1);
				} else {
					// In compatibility mode, warn but continue with the default path
					console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
					console.error('[SERVER] This may cause issues when executing Godot commands');
					console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
				}
			}

			console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

			const transport = new StdioServerTransport();
			await this.server.connect(transport);
			console.error('Godot MCP server running on stdio');
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			console.error('[SERVER] Failed to start:', errorMessage);
			process.exit(1);
		}
	}
}

// Create and run the server
const server = new GodotServer();
server.run().catch((error: unknown) => {
	const errorMessage = error instanceof Error ? error.message : 'Unknown error';
	console.error('Failed to run server:', errorMessage);
	process.exit(1);
});
