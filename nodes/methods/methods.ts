import FirecrawlApp from '@mendable/firecrawl-js';
import { IExecuteFunctions, INodeExecutionData, NodeOperationError, IDataObject } from 'n8n-workflow';

// Global functions declaration for Node.js environment
declare const fetch: typeof globalThis.fetch;
declare const setTimeout: typeof globalThis.setTimeout;

interface CommunityNodeResult extends IDataObject {
	type: 'community';
	nodeType: string;
	packageName: string;
	previousVersion?: string;
	currentVersion: string;
	hasUpdate: boolean;
	npmUrl: string;
	githubUrl?: string;
	lastPublished: string;
	changelog?: string;
	success: boolean;
	error?: string;
}

interface BaseNodeResult extends IDataObject {
	type: 'base';
	nodeType: string;
	nodeName: string;
	mentionedInRecentReleases: boolean;
	mentionedInRecentCommits: boolean;
	patchNotes?: string;
	githubReleasesUrl: string;
	githubCommitsUrl: string;
	success: boolean;
	error?: string;
}

export const nodeUpdateCheckerMethods = {
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const returnData: INodeExecutionData[] = [];

		// Get credentials (optional now)
		let firecrawl: FirecrawlApp | undefined;
		try {
			const credentials = await this.getCredentials('firecrawlApi');
			if (credentials && credentials.apiKey) {
				const apiKey = credentials.apiKey as string;
				firecrawl = new FirecrawlApp({ apiKey });
			}
		} catch (error) {
			// Credentials not provided, continue without Firecrawl
			firecrawl = undefined;
		}

		// Get parameters
		const operation = this.getNodeParameter('operation', 0) as string;
		const outputFormat = this.getNodeParameter('outputFormat', 0) as string;
		const packageNamesInput = this.getNodeParameter('packageNames', 0, '') as string;
		const previousVersionsInput = this.getNodeParameter('previousVersions', 0, '{}') as string;
		const useStaticData = this.getNodeParameter('options.useStaticData', 0, false) as boolean;
		
		let previousVersions: Record<string, string> = {};
		
		// Load from static data or parameter
		if (useStaticData) {
			const staticData = this.getWorkflowStaticData('global');
			previousVersions = (staticData.nodeVersions as Record<string, string>) || {};
		} else {
			try {
				previousVersions = JSON.parse(previousVersionsInput);
			} catch (error) {
				throw new NodeOperationError(
					this.getNode(),
					'Invalid JSON format for Previous Versions',
				);
			}
		}

		const options = this.getNodeParameter('options', 0, {}) as {
			checkDelay?: number;
			includePreview?: boolean;
			fetchGithubRepo?: boolean;
			extractPatchNotes?: boolean;
		};

		const checkDelay = options.checkDelay || 1500;
		const fetchGithubRepo = options.fetchGithubRepo !== false;
		const extractPatchNotes = options.extractPatchNotes !== false;

		// Get current workflow metadata
		const workflow = this.getWorkflow();
		
		// Parse package names from input
		const communityNodes: string[] = [];
		const baseNodes: string[] = [];
		
		if (packageNamesInput.trim()) {
			const packages = packageNamesInput.split(',').map(p => p.trim()).filter(p => p);
			for (const pkg of packages) {
				// Add .node suffix if not present
				const nodeType = pkg.includes('.') ? pkg : `${pkg}.node`;
				communityNodes.push(nodeType);
			}
		}
		
		console.log('Packages to check:', communityNodes);

		const communityResults: CommunityNodeResult[] = [];
		const baseResults: BaseNodeResult[] = [];

		try {
			// Check community nodes on npm
			if (operation === 'checkAll' || operation === 'checkCommunity') {
				for (const nodeType of [...new Set(communityNodes)]) {
					try {
						const result = await checkCommunityNode.call(
							this,
							firecrawl,
							nodeType,
							previousVersions,
							fetchGithubRepo,
							checkDelay,
						);
						communityResults.push(result);
						// Use proper setTimeout without global prefix in Node.js environment
						await new Promise<void>(resolve => setTimeout(() => resolve(), checkDelay));
					} catch (error) {
						communityResults.push({
							type: 'community',
							nodeType,
							packageName: nodeType.split('.')[0],
							currentVersion: 'unknown',
							hasUpdate: false,
							npmUrl: '',
							lastPublished: 'unknown',
							error: error instanceof Error ? error.message : String(error),
							success: false,
						});
					}
				}
			}

			// Check base nodes on n8n GitHub
			if ((operation === 'checkAll' || operation === 'checkBase') && baseNodes.length > 0) {
				if (!firecrawl) {
					// Skip base node checking if Firecrawl is not configured
					baseResults.push({
						type: 'base',
						nodeType: 'all',
						nodeName: 'all',
						mentionedInRecentReleases: false,
						mentionedInRecentCommits: false,
						githubReleasesUrl: '',
						githubCommitsUrl: '',
						error: 'Firecrawl API credentials required for base node checking',
						success: false,
					});
				} else {
					try {
						const baseNodeResults = await checkBaseNodes.call(
							this,
							firecrawl,
							baseNodes,
							extractPatchNotes,
							checkDelay,
						);
						baseResults.push(...baseNodeResults);
					} catch (error) {
						baseResults.push({
							type: 'base',
							nodeType: 'all',
							nodeName: 'all',
							mentionedInRecentReleases: false,
							mentionedInRecentCommits: false,
							githubReleasesUrl: '',
							githubCommitsUrl: '',
							error: error instanceof Error ? error.message : String(error),
							success: false,
						});
					}
				}
			}

			// Generate outputs based on format
			if (outputFormat === 'json' || outputFormat === 'both') {
				// Add JSON results
				for (const result of communityResults) {
					returnData.push({ json: result as IDataObject });
				}
				for (const result of baseResults) {
					returnData.push({ json: result as IDataObject });
				}
			}

			if (outputFormat === 'emailText' || outputFormat === 'both') {
				// Generate email text
				const emailText = generateEmailText(communityResults, baseResults, workflow.name || 'Workflow');
				returnData.push({
					json: {
						type: 'email_report',
						emailText,
						workflowName: workflow.name || 'Workflow',
						checkedAt: new Date().toISOString(),
					},
				});
			}

			// Add summary
			const summary = {
				totalPackages: communityNodes.length + baseNodes.length,
				communityNodesCount: communityNodes.length,
				baseNodesCount: baseNodes.length,
				communityNodesWithUpdates: communityResults.filter(r => r.hasUpdate).length,
				baseNodesWithUpdates: baseResults.filter(
					r => r.mentionedInRecentReleases || r.mentionedInRecentCommits,
				).length,
				checkedAt: new Date().toISOString(),
			};

			// Save current versions to static data if enabled
			if (useStaticData) {
				const staticData = this.getWorkflowStaticData('global');
				const currentVersions: Record<string, string> = {};
				
				for (const result of communityResults) {
					if (result.success && result.currentVersion !== 'unknown') {
						currentVersions[result.packageName] = result.currentVersion;
					}
				}
				
				staticData.nodeVersions = currentVersions;
				
				// Add info about saved versions
				returnData.push({
					json: {
						type: 'version_storage',
						message: 'Versions saved to workflow static data',
						savedVersions: currentVersions,
						savedAt: new Date().toISOString(),
					},
				});
			}

			returnData.unshift({
				json: {
					summary,
					workflowName: workflow.name || 'Workflow',
					operation,
					outputFormat,
				},
			});

		} catch (error: unknown) {
			if (this.continueOnFail()) {
				returnData.push({
					json: {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
				});
			} else {
				throw new NodeOperationError(this.getNode(), error as Error);
			}
		}

		return [returnData];
	},
};

// Helper functions
async function checkCommunityNode(
	this: IExecuteFunctions,
	firecrawl: FirecrawlApp | undefined,
	nodeType: string,
	previousVersions: Record<string, string>,
	fetchGithubRepo: boolean,
	checkDelay: number,
): Promise<CommunityNodeResult> {
	const packageName = nodeType.split('.')[0];
	const npmUrl = `https://www.npmjs.com/package/${packageName}`;
	
	// Use npm registry API instead of scraping
	const registryUrl = `https://registry.npmjs.org/${packageName}`;
	
	try {
		// Fetch from npm registry API
		const response = await fetch(registryUrl);
		
		if (!response.ok) {
			throw new Error(`npm registry returned ${response.status}`);
		}
		
		const registryData = await response.json() as any;
		
		// Get latest version from dist-tags
		const currentVersion = registryData['dist-tags']?.latest || 'unknown';
		
		// Get last publish time
		const timeData = registryData.time || {};
		const publishedAt = timeData[currentVersion];
		let lastPublished = 'unknown';
		
		if (publishedAt) {
			const publishDate = new Date(publishedAt);
			const now = new Date();
			const diffMs = now.getTime() - publishDate.getTime();
			const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
			
			if (diffDays === 0) {
				const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
				if (diffHours === 0) {
					const diffMinutes = Math.floor(diffMs / (1000 * 60));
					lastPublished = `${diffMinutes} minutes ago`;
				} else {
					lastPublished = `${diffHours} hours ago`;
				}
			} else if (diffDays === 1) {
				lastPublished = '1 day ago';
			} else if (diffDays < 30) {
				lastPublished = `${diffDays} days ago`;
			} else if (diffDays < 365) {
				const months = Math.floor(diffDays / 30);
				lastPublished = months === 1 ? '1 month ago' : `${months} months ago`;
			} else {
				const years = Math.floor(diffDays / 365);
				lastPublished = years === 1 ? '1 year ago' : `${years} years ago`;
			}
		}
		
		// Check for version change
		const previousVersion = previousVersions[packageName];
		const hasUpdate = previousVersion ? previousVersion !== currentVersion : false;
		
		// Get GitHub URL from repository field
		let githubUrl: string | undefined;
		if (fetchGithubRepo) {
			const repository = registryData.repository;
			if (repository) {
				let repoUrl = typeof repository === 'string' ? repository : repository.url;
				if (repoUrl) {
					// Clean up git+https:// and .git
					repoUrl = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
					if (repoUrl.includes('github.com')) {
						githubUrl = repoUrl;
					}
				}
			}
		}
		
		// Try to get changelog if there's an update
		let changelog: string | undefined;
		if (hasUpdate && githubUrl && firecrawl) {
			try {
				await new Promise<void>(resolve => setTimeout(() => resolve(), checkDelay));
				const changelogUrl = `${githubUrl}/releases`;
				const changelogResponse = await firecrawl.scrapeUrl(changelogUrl, {
					formats: ['markdown'],
				});
				const changelogContent = (changelogResponse as any).markdown || '';
				
				// Extract relevant release notes
				changelog = extractRelevantChangelog(
					changelogContent,
					previousVersion || '',
					currentVersion,
				);
			} catch (error) {
				// Changelog fetch failed, continue without it
			}
		}
		
		return {
			type: 'community',
			nodeType,
			packageName,
			previousVersion,
			currentVersion,
			hasUpdate,
			npmUrl,
			githubUrl,
			lastPublished,
			changelog,
			success: true,
		};
		
	} catch (error) {
		// Fallback to unknown if API fails
		return {
			type: 'community',
			nodeType,
			packageName,
			previousVersion: previousVersions[packageName],
			currentVersion: 'unknown',
			hasUpdate: false,
			npmUrl,
			lastPublished: 'unknown',
			error: error instanceof Error ? error.message : String(error),
			success: false,
		};
	}
}

async function checkBaseNodes(
	this: IExecuteFunctions,
	firecrawl: FirecrawlApp,
	baseNodes: string[],
	extractPatchNotes: boolean,
	checkDelay: number,
): Promise<BaseNodeResult[]> {
	const results: BaseNodeResult[] = [];

	// Crawl n8n GitHub releases page
	const githubReleasesUrl = 'https://github.com/n8n-io/n8n/releases';
	const githubResponse = await firecrawl.scrapeUrl(githubReleasesUrl, {
		formats: ['markdown'],
	});
	const releasesContent = (githubResponse as any).markdown || '';

	await new Promise<void>(resolve => setTimeout(() => resolve(), checkDelay));

	// Crawl commits page
	const nodesCommitsUrl = 'https://github.com/n8n-io/n8n/commits/master/packages/nodes-base/nodes';
	const commitsResponse = await firecrawl.scrapeUrl(nodesCommitsUrl, {
		formats: ['markdown'],
	});
	const commitsContent = (commitsResponse as any).markdown || '';

	// Check each base node
	for (const nodeType of [...new Set(baseNodes)]) {
		const nodeName = nodeType.split('.').pop() || nodeType;
		
		const mentionedInReleases = releasesContent.toLowerCase().includes(nodeName.toLowerCase());
		const mentionedInCommits = commitsContent.toLowerCase().includes(nodeName.toLowerCase());

		let patchNotes: string | undefined;
		if (extractPatchNotes && (mentionedInReleases || mentionedInCommits)) {
			patchNotes = extractPatchNotesFromContent(
				releasesContent,
				commitsContent,
				nodeName,
			);
		}

		results.push({
			type: 'base',
			nodeType,
			nodeName,
			mentionedInRecentReleases: mentionedInReleases,
			mentionedInRecentCommits: mentionedInCommits,
			patchNotes,
			githubReleasesUrl,
			githubCommitsUrl: nodesCommitsUrl,
			success: true,
		});
	}

	return results;
}

function extractRelevantChangelog(
	changelogContent: string,
	previousVersion: string,
	currentVersion: string,
): string {
	// Find content between versions
	const lines = changelogContent.split('\n');
	const relevantLines: string[] = [];
	let capturing = false;

	for (const line of lines) {
		if (line.includes(currentVersion)) {
			capturing = true;
		}
		if (capturing) {
			relevantLines.push(line);
		}
		if (previousVersion && line.includes(previousVersion)) {
			break;
		}
		// Limit to 50 lines
		if (relevantLines.length > 50) break;
	}

	return relevantLines.join('\n').substring(0, 2000);
}

function extractPatchNotesFromContent(
	releasesContent: string,
	commitsContent: string,
	nodeName: string,
): string {
	const notes: string[] = [];
	
	// Extract from releases
	const releaseSnippet = extractContextSnippet(releasesContent, nodeName, 300);
	if (releaseSnippet) {
		notes.push('**From Releases:**\n' + releaseSnippet);
	}

	// Extract from commits
	const commitSnippet = extractContextSnippet(commitsContent, nodeName, 300);
	if (commitSnippet) {
		notes.push('**From Recent Commits:**\n' + commitSnippet);
	}

	return notes.join('\n\n');
}

function extractContextSnippet(content: string, searchTerm: string, maxLength: number = 200): string {
	const lowerContent = content.toLowerCase();
	const lowerTerm = searchTerm.toLowerCase();
	const index = lowerContent.indexOf(lowerTerm);
	
	if (index === -1) return '';
	
	const start = Math.max(0, index - 100);
	const end = Math.min(content.length, index + maxLength);
	
	return '...' + content.substring(start, end).trim() + '...';
}

function generateEmailText(
	communityResults: CommunityNodeResult[],
	baseResults: BaseNodeResult[],
	workflowName: string,
): string {
	const lines: string[] = [];
	
	lines.push(`# Node Update Report for: ${workflowName}`);
	lines.push(`Generated: ${new Date().toLocaleString()}`);
	lines.push('');
	lines.push('---');
	lines.push('');

	// Community Nodes Section
	const updatedCommunity = communityResults.filter(r => r.hasUpdate && r.success);
	if (updatedCommunity.length > 0) {
		lines.push('## 📦 Community Nodes with Updates');
		lines.push('');

		for (const node of updatedCommunity) {
			lines.push(`### ${node.packageName}`);
			lines.push(`- **Version Change**: ${node.previousVersion || 'unknown'} → ${node.currentVersion}`);
			lines.push(`- **npm**: ${node.npmUrl}`);
			if (node.githubUrl) {
				lines.push(`- **GitHub**: ${node.githubUrl}`);
				lines.push(`- **Releases**: ${node.githubUrl}/releases`);
			}
			lines.push(`- **Last Published**: ${node.lastPublished}`);
			
			if (node.changelog) {
				lines.push('');
				lines.push('**Changelog:**');
				lines.push('```');
				lines.push(node.changelog);
				lines.push('```');
			}
			lines.push('');
		}
	} else {
		lines.push('## 📦 Community Nodes');
		lines.push('No updates detected for community nodes.');
		lines.push('');
	}

	// Base Nodes Section
	const updatedBase = baseResults.filter(
		r => (r.mentionedInRecentReleases || r.mentionedInRecentCommits) && r.success,
	);
	if (updatedBase.length > 0) {
		lines.push('## 🔧 Base Nodes with Recent Activity');
		lines.push('');

		for (const node of updatedBase) {
			lines.push(`### ${node.nodeName}`);
			if (node.mentionedInRecentReleases) {
				lines.push('- ✅ Mentioned in recent releases');
			}
			if (node.mentionedInRecentCommits) {
				lines.push('- ✅ Mentioned in recent commits');
			}
			lines.push(`- **GitHub Releases**: ${node.githubReleasesUrl}`);
			lines.push(`- **Commits**: ${node.githubCommitsUrl}`);
			
			if (node.patchNotes) {
				lines.push('');
				lines.push('**Patch Notes:**');
				lines.push('```');
				lines.push(node.patchNotes);
				lines.push('```');
			}
			lines.push('');
		}
	} else {
		lines.push('## 🔧 Base Nodes');
		lines.push('No recent activity detected for base nodes.');
		lines.push('');
	}

	// No Updates Section
	const noUpdatesCommunity = communityResults.filter(r => !r.hasUpdate && r.success);
	const noUpdatesBase = baseResults.filter(
		r => !r.mentionedInRecentReleases && !r.mentionedInRecentCommits && r.success,
	);

	if (noUpdatesCommunity.length > 0 || noUpdatesBase.length > 0) {
		lines.push('---');
		lines.push('## ℹ️ Nodes Without Updates');
		lines.push('');

		if (noUpdatesCommunity.length > 0) {
			lines.push('**Community Nodes:**');
			for (const node of noUpdatesCommunity) {
				lines.push(`- ${node.packageName} (${node.currentVersion})`);
			}
			lines.push('');
		}

		if (noUpdatesBase.length > 0) {
			lines.push('**Base Nodes:**');
			for (const node of noUpdatesBase) {
				lines.push(`- ${node.nodeName}`);
			}
			lines.push('');
		}
	}

	lines.push('---');
	lines.push('');
	lines.push('*This report was automatically generated by n8n Workflow Node Checker*');

	return lines.join('\n');
}