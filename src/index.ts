#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';

// PubChem API interfaces
interface CompoundSearchResult {
  IdentifierList: {
    CID: number[];
  };
}

interface PropertyData {
  PropertyTable: {
    Properties: Array<{
      CID: number;
      MolecularFormula?: string;
      MolecularWeight?: number;
      CanonicalSMILES?: string;
      IsomericSMILES?: string;
      InChI?: string;
      InChIKey?: string;
      IUPACName?: string;
      XLogP?: number;
      TPSA?: number;
      Complexity?: number;
      Charge?: number;
      HBondDonorCount?: number;
      HBondAcceptorCount?: number;
      RotatableBondCount?: number;
      HeavyAtomCount?: number;
      AtomStereoCount?: number;
      DefinedAtomStereoCount?: number;
      BondStereoCount?: number;
      DefinedBondStereoCount?: number;
      Volume3D?: number;
      ConformerCount3D?: number;
    }>;
  };
}

// Type guards and validation functions
const isValidCompoundSearchArgs = (
  args: any
): args is { query: string; search_type?: string; max_records?: number } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.query === 'string' &&
    args.query.length > 0 &&
    (args.search_type === undefined || ['name', 'smiles', 'inchi', 'sdf', 'cid', 'formula'].includes(args.search_type)) &&
    (args.max_records === undefined || (typeof args.max_records === 'number' && args.max_records > 0 && args.max_records <= 10000))
  );
};

const isValidCidArgs = (
  args: any
): args is { cid: number | string; format?: string } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    (typeof args.cid === 'number' || typeof args.cid === 'string') &&
    (args.format === undefined || ['json', 'sdf', 'xml', 'asnt', 'asnb'].includes(args.format))
  );
};

const isValidSmilesArgs = (
  args: any
): args is { smiles: string; threshold?: number; max_records?: number } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.smiles === 'string' &&
    args.smiles.length > 0 &&
    (args.threshold === undefined || (typeof args.threshold === 'number' && args.threshold >= 0 && args.threshold <= 100)) &&
    (args.max_records === undefined || (typeof args.max_records === 'number' && args.max_records > 0 && args.max_records <= 10000))
  );
};

const isValidBatchArgs = (
  args: any
): args is { cids: number[]; operation?: string } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    Array.isArray(args.cids) &&
    args.cids.length > 0 &&
    args.cids.length <= 200 &&
    args.cids.every((cid: any) => typeof cid === 'number' && cid > 0) &&
    (args.operation === undefined || ['property', 'synonyms', 'classification', 'description'].includes(args.operation))
  );
};

const isValidConformerArgs = (
  args: any
): args is { cid: number | string; conformer_type?: string } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    (typeof args.cid === 'number' || typeof args.cid === 'string') &&
    (args.conformer_type === undefined || ['3d', '2d'].includes(args.conformer_type))
  );
};

const isValidPropertiesArgs = (
  args: any
): args is { cid: number | string; properties?: string[] } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    (typeof args.cid === 'number' || typeof args.cid === 'string') &&
    (args.properties === undefined || (Array.isArray(args.properties) && args.properties.every((p: any) => typeof p === 'string')))
  );
};

const isValidBioactivityArgs = (
  args: any
): args is { cid: number | string; activity_outcome?: string } => {
  return (
    typeof args === 'object' &&
    args !== null &&
    (typeof args.cid === 'number' || typeof args.cid === 'string') &&
    (args.activity_outcome === undefined || ['active', 'inactive', 'inconclusive', 'all'].includes(args.activity_outcome))
  );
};

class PubChemServer {
  private server: Server;
  private apiClient: AxiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'pubchem-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    // Initialize PubChem API client
    this.apiClient = axios.create({
      baseURL: 'https://pubchem.ncbi.nlm.nih.gov/rest/pug',
      timeout: 30000,
      headers: {
        'User-Agent': 'PubChem-MCP-Server/1.0.0',
        'Accept': 'application/json',
      },
    });

    this.setupResourceHandlers();
    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error: any) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupResourceHandlers() {
    // List available resource templates
    this.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => ({
        resourceTemplates: [
          {
            uriTemplate: 'pubchem://compound/{cid}',
            name: 'PubChem compound entry',
            mimeType: 'application/json',
            description: 'Complete compound information for a PubChem CID',
          },
          {
            uriTemplate: 'pubchem://structure/{cid}',
            name: 'Chemical structure data',
            mimeType: 'application/json',
            description: '2D/3D structure information for a compound',
          },
          {
            uriTemplate: 'pubchem://properties/{cid}',
            name: 'Chemical properties',
            mimeType: 'application/json',
            description: 'Molecular properties and descriptors for a compound',
          },
          {
            uriTemplate: 'pubchem://bioassay/{aid}',
            name: 'PubChem bioassay data',
            mimeType: 'application/json',
            description: 'Bioassay information and results for an AID',
          },
          {
            uriTemplate: 'pubchem://similarity/{smiles}',
            name: 'Similarity search results',
            mimeType: 'application/json',
            description: 'Chemical similarity search results for a SMILES string',
          },
          {
            uriTemplate: 'pubchem://safety/{cid}',
            name: 'Safety and toxicity data',
            mimeType: 'application/json',
            description: 'Safety classifications and toxicity information',
          },
        ],
      })
    );

    // Handle resource requests
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request: any) => {
        const uri = request.params.uri;

        // Handle compound info requests
        const compoundMatch = uri.match(/^pubchem:\/\/compound\/([0-9]+)$/);
        if (compoundMatch) {
          const cid = compoundMatch[1];
          try {
            const response = await this.apiClient.get(`/compound/cid/${cid}/JSON`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch compound ${cid}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Handle structure requests
        const structureMatch = uri.match(/^pubchem:\/\/structure\/([0-9]+)$/);
        if (structureMatch) {
          const cid = structureMatch[1];
          try {
            const response = await this.apiClient.get(`/compound/cid/${cid}/property/CanonicalSMILES,IsomericSMILES,InChI,InChIKey/JSON`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch structure for ${cid}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Handle properties requests
        const propertiesMatch = uri.match(/^pubchem:\/\/properties\/([0-9]+)$/);
        if (propertiesMatch) {
          const cid = propertiesMatch[1];
          try {
            const response = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularWeight,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,Complexity/JSON`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch properties for ${cid}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Handle bioassay requests
        const bioassayMatch = uri.match(/^pubchem:\/\/bioassay\/([0-9]+)$/);
        if (bioassayMatch) {
          const aid = bioassayMatch[1];
          try {
            const response = await this.apiClient.get(`/assay/aid/${aid}/JSON`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch bioassay ${aid}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Handle similarity search requests
        const similarityMatch = uri.match(/^pubchem:\/\/similarity\/(.+)$/);
        if (similarityMatch) {
          const smiles = decodeURIComponent(similarityMatch[1]);
          try {
            const response = await this.apiClient.post('/compound/similarity/smiles/JSON', {
              smiles: smiles,
              Threshold: 90,
              MaxRecords: 100,
            });
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to perform similarity search: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Handle safety data requests
        const safetyMatch = uri.match(/^pubchem:\/\/safety\/([0-9]+)$/);
        if (safetyMatch) {
          const cid = safetyMatch[1];
          try {
            const response = await this.apiClient.get(`/compound/cid/${cid}/classification/JSON`);
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(response.data, null, 2),
                },
              ],
            };
          } catch (error) {
            throw new McpError(
              ErrorCode.InternalError,
              `Failed to fetch safety data for ${cid}: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        throw new McpError(
          ErrorCode.InvalidRequest,
          `Invalid URI format: ${uri}`
        );
      }
    );
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // Chemical Search & Retrieval (6 tools)
        {
          name: 'search_compounds',
          description: 'Search PubChem database for compounds by name, CAS number, formula, or identifier',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (compound name, CAS, formula, or identifier)' },
              search_type: { type: 'string', enum: ['name', 'smiles', 'inchi', 'sdf', 'cid', 'formula'], description: 'Type of search to perform (default: name)' },
              max_records: { type: 'number', description: 'Maximum number of results (1-10000, default: 100)', minimum: 1, maximum: 10000 },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_compound_info',
          description: 'Get detailed information for a specific compound by PubChem CID',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
              format: { type: 'string', enum: ['json', 'sdf', 'xml', 'asnt', 'asnb'], description: 'Output format (default: json)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'search_by_smiles',
          description: 'Search for compounds by SMILES string (exact match)',
          inputSchema: {
            type: 'object',
            properties: {
              smiles: { type: 'string', description: 'SMILES string of the query molecule' },
            },
            required: ['smiles'],
          },
        },
        {
          name: 'search_by_inchi',
          description: 'Search for compounds by InChI or InChI key',
          inputSchema: {
            type: 'object',
            properties: {
              inchi: { type: 'string', description: 'InChI string or InChI key' },
            },
            required: ['inchi'],
          },
        },
        {
          name: 'search_by_cas_number',
          description: 'Search for compounds by CAS Registry Number',
          inputSchema: {
            type: 'object',
            properties: {
              cas_number: { type: 'string', description: 'CAS Registry Number (e.g., 50-78-2)' },
            },
            required: ['cas_number'],
          },
        },
        {
          name: 'get_compound_synonyms',
          description: 'Get all names and synonyms for a compound',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },

        // Structure Analysis & Similarity (5 tools)
        {
          name: 'search_similar_compounds',
          description: 'Find chemically similar compounds using Tanimoto similarity',
          inputSchema: {
            type: 'object',
            properties: {
              smiles: { type: 'string', description: 'SMILES string of the query molecule' },
              threshold: { type: 'number', description: 'Similarity threshold (0-100, default: 90)', minimum: 0, maximum: 100 },
              max_records: { type: 'number', description: 'Maximum number of results (1-10000, default: 100)', minimum: 1, maximum: 10000 },
            },
            required: ['smiles'],
          },
        },
        {
          name: 'substructure_search',
          description: 'Find compounds containing a specific substructure',
          inputSchema: {
            type: 'object',
            properties: {
              smiles: { type: 'string', description: 'SMILES string of the substructure query' },
              max_records: { type: 'number', description: 'Maximum number of results (1-10000, default: 100)', minimum: 1, maximum: 10000 },
            },
            required: ['smiles'],
          },
        },
        {
          name: 'superstructure_search',
          description: 'Find larger compounds that contain the query structure',
          inputSchema: {
            type: 'object',
            properties: {
              smiles: { type: 'string', description: 'SMILES string of the query structure' },
              max_records: { type: 'number', description: 'Maximum number of results (1-10000, default: 100)', minimum: 1, maximum: 10000 },
            },
            required: ['smiles'],
          },
        },
        {
          name: 'get_3d_conformers',
          description: 'Get 3D conformer data and structural information',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
              conformer_type: { type: 'string', enum: ['3d', '2d'], description: 'Type of conformer data (default: 3d)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'analyze_stereochemistry',
          description: 'Analyze stereochemistry, chirality, and isomer information',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },

        // Chemical Properties & Descriptors (6 tools)
        {
          name: 'get_compound_properties',
          description: 'Get molecular properties (MW, logP, TPSA, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
              properties: { type: 'array', items: { type: 'string' }, description: 'Specific properties to retrieve (optional)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'calculate_descriptors',
          description: 'Calculate comprehensive molecular descriptors and fingerprints',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
              descriptor_type: { type: 'string', enum: ['all', 'basic', 'topological', '3d'], description: 'Type of descriptors (default: all)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'predict_admet_properties',
          description: 'Predict ADMET properties (Absorption, Distribution, Metabolism, Excretion, Toxicity)',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
              smiles: { type: 'string', description: 'SMILES string (alternative to CID)' },
            },
            required: [],
          },
        },
        {
          name: 'assess_drug_likeness',
          description: 'Assess drug-likeness using Lipinski Rule of Five, Veber rules, and PAINS filters',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
              smiles: { type: 'string', description: 'SMILES string (alternative to CID)' },
            },
            required: [],
          },
        },
        {
          name: 'analyze_molecular_complexity',
          description: 'Analyze molecular complexity and synthetic accessibility',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'get_pharmacophore_features',
          description: 'Get pharmacophore features and binding site information',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },

        // Bioassay & Activity Data (5 tools)
        {
          name: 'search_bioassays',
          description: 'Search for biological assays by target, description, or source',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'General search query' },
              target: { type: 'string', description: 'Target protein or gene name' },
              source: { type: 'string', description: 'Data source (e.g., ChEMBL, NCGC)' },
              max_records: { type: 'number', description: 'Maximum number of results (1-1000, default: 100)', minimum: 1, maximum: 1000 },
            },
            required: [],
          },
        },
        {
          name: 'get_assay_info',
          description: 'Get detailed information for a specific bioassay by AID',
          inputSchema: {
            type: 'object',
            properties: {
              aid: { type: 'number', description: 'PubChem Assay ID (AID)' },
            },
            required: ['aid'],
          },
        },
        {
          name: 'get_compound_bioactivities',
          description: 'Get all bioassay results and activities for a compound',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
              activity_outcome: { type: 'string', enum: ['active', 'inactive', 'inconclusive', 'all'], description: 'Filter by activity outcome (default: all)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'search_by_target',
          description: 'Find compounds tested against a specific biological target',
          inputSchema: {
            type: 'object',
            properties: {
              target: { type: 'string', description: 'Target name (gene, protein, or pathway)' },
              activity_type: { type: 'string', description: 'Type of activity (e.g., IC50, EC50, Ki)' },
              max_records: { type: 'number', description: 'Maximum number of results (1-1000, default: 100)', minimum: 1, maximum: 1000 },
            },
            required: ['target'],
          },
        },
        {
          name: 'compare_activity_profiles',
          description: 'Compare bioactivity profiles across multiple compounds',
          inputSchema: {
            type: 'object',
            properties: {
              cids: { type: 'array', items: { type: 'number' }, description: 'Array of PubChem CIDs (2-50)', minItems: 2, maxItems: 50 },
              activity_type: { type: 'string', description: 'Specific activity type for comparison (optional)' },
            },
            required: ['cids'],
          },
        },

        // Safety & Toxicity (4 tools)
        {
          name: 'get_safety_data',
          description: 'Get GHS hazard classifications and safety information',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'get_toxicity_info',
          description: 'Get toxicity data including LD50, carcinogenicity, and mutagenicity',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'assess_environmental_fate',
          description: 'Assess environmental fate including biodegradation and bioaccumulation',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'get_regulatory_info',
          description: 'Get regulatory information from FDA, EPA, and international agencies',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },

        // Cross-References & Integration (4 tools)
        {
          name: 'get_external_references',
          description: 'Get links to external databases (ChEMBL, DrugBank, KEGG, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'search_patents',
          description: 'Search for chemical patents and intellectual property information',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
              query: { type: 'string', description: 'Patent search query (alternative to CID)' },
            },
            required: [],
          },
        },
        {
          name: 'get_literature_references',
          description: 'Get PubMed citations and scientific literature references',
          inputSchema: {
            type: 'object',
            properties: {
              cid: { type: ['number', 'string'], description: 'PubChem Compound ID (CID)' },
            },
            required: ['cid'],
          },
        },
        {
          name: 'batch_compound_lookup',
          description: 'Process multiple compound IDs efficiently',
          inputSchema: {
            type: 'object',
            properties: {
              cids: { type: 'array', items: { type: 'number' }, description: 'Array of PubChem CIDs (1-200)', minItems: 1, maxItems: 200 },
              operation: { type: 'string', enum: ['property', 'synonyms', 'classification', 'description'], description: 'Operation to perform (default: property)' },
            },
            required: ['cids'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          // Chemical Search & Retrieval
          case 'search_compounds':
            return await this.handleSearchCompounds(args);
          case 'get_compound_info':
            return await this.handleGetCompoundInfo(args);
          case 'search_by_smiles':
            return await this.handleSearchBySmiles(args);
          case 'search_by_inchi':
            return await this.handleSearchByInchi(args);
          case 'search_by_cas_number':
            return await this.handleSearchByCasNumber(args);
          case 'get_compound_synonyms':
            return await this.handleGetCompoundSynonyms(args);

          // Structure Analysis & Similarity
          case 'search_similar_compounds':
            return await this.handleSearchSimilarCompounds(args);
          case 'substructure_search':
            return await this.handleSubstructureSearch(args);
          case 'superstructure_search':
            return await this.handleSuperstructureSearch(args);
          case 'get_3d_conformers':
            return await this.handleGet3dConformers(args);
          case 'analyze_stereochemistry':
            return await this.handleAnalyzeStereochemistry(args);

          // Chemical Properties & Descriptors
          case 'get_compound_properties':
            return await this.handleGetCompoundProperties(args);
          case 'calculate_descriptors':
            return await this.handleCalculateDescriptors(args);
          case 'predict_admet_properties':
            return await this.handlePredictAdmetProperties(args);
          case 'assess_drug_likeness':
            return await this.handleAssessDrugLikeness(args);
          case 'analyze_molecular_complexity':
            return await this.handleAnalyzeMolecularComplexity(args);
          case 'get_pharmacophore_features':
            return await this.handleGetPharmacophoreFeatures(args);

          // Bioassay & Activity Data
          case 'search_bioassays':
            return await this.handleSearchBioassays(args);
          case 'get_assay_info':
            return await this.handleGetAssayInfo(args);
          case 'get_compound_bioactivities':
            return await this.handleGetCompoundBioactivities(args);
          case 'search_by_target':
            return await this.handleSearchByTarget(args);
          case 'compare_activity_profiles':
            return await this.handleCompareActivityProfiles(args);

          // Safety & Toxicity
          case 'get_safety_data':
            return await this.handleGetSafetyData(args);
          case 'get_toxicity_info':
            return await this.handleGetToxicityInfo(args);
          case 'assess_environmental_fate':
            return await this.handleAssessEnvironmentalFate(args);
          case 'get_regulatory_info':
            return await this.handleGetRegulatoryInfo(args);

          // Cross-References & Integration
          case 'get_external_references':
            return await this.handleGetExternalReferences(args);
          case 'search_patents':
            return await this.handleSearchPatents(args);
          case 'get_literature_references':
            return await this.handleGetLiteratureReferences(args);
          case 'batch_compound_lookup':
            return await this.handleBatchCompoundLookup(args);

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing tool ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  // Chemical Search & Retrieval handlers
  private async handleSearchCompounds(args: any) {
    if (!isValidCompoundSearchArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid compound search arguments');
    }

    try {
      const searchType = args.search_type || 'name';
      const maxRecords = args.max_records || 100;

      const response = await this.apiClient.get(`/compound/${searchType}/${encodeURIComponent(args.query)}/cids/JSON`, {
        params: {
          MaxRecords: maxRecords,
        },
      });

      if (response.data?.IdentifierList?.CID?.length > 0) {
        const cids = response.data.IdentifierList.CID.slice(0, 10);
        const detailsResponse = await this.apiClient.get(`/compound/cid/${cids.join(',')}/property/MolecularFormula,MolecularWeight,CanonicalSMILES,IUPACName/JSON`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query: args.query,
                search_type: searchType,
                total_found: response.data.IdentifierList.CID.length,
                details: detailsResponse.data,
              }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'No compounds found', query: args.query }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search compounds: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetCompoundInfo(args: any) {
    if (!isValidCidArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid CID arguments');
    }

    try {
      const format = args.format || 'json';
      const response = await this.apiClient.get(`/compound/cid/${args.cid}/${format === 'json' ? 'JSON' : format}`);

      return {
        content: [
          {
            type: 'text',
            text: format === 'json' ? JSON.stringify(response.data, null, 2) : String(response.data),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get compound info: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleSearchBySmiles(args: any) {
    if (!isValidSmilesArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid SMILES arguments');
    }

    try {
      const response = await this.apiClient.get(`/compound/smiles/${encodeURIComponent(args.smiles)}/cids/JSON`);

      if (response.data?.IdentifierList?.CID?.length > 0) {
        const cid = response.data.IdentifierList.CID[0];
        const detailsResponse = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularFormula,MolecularWeight,CanonicalSMILES,IUPACName/JSON`);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query_smiles: args.smiles,
                found_cid: cid,
                details: detailsResponse.data,
              }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'No exact match found', query_smiles: args.smiles }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search by SMILES: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Simplified implementation handlers (placeholder implementations)
  private async handleSearchByInchi(args: any) {
    return { content: [{ type: 'text', text: JSON.stringify({ message: 'InChI search not yet implemented', args }, null, 2) }] };
  }

  private async handleSearchByCasNumber(args: any) {
    return { content: [{ type: 'text', text: JSON.stringify({ message: 'CAS search not yet implemented', args }, null, 2) }] };
  }

  private async handleGetCompoundSynonyms(args: any) {
    if (!isValidCidArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid CID arguments');
    }

    try {
      const response = await this.apiClient.get(`/compound/cid/${args.cid}/synonyms/JSON`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get compound synonyms: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleSearchSimilarCompounds(args: any) {
    if (!isValidSmilesArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid similarity search arguments');
    }

    try {
      const threshold = args.threshold || 90;
      const maxRecords = args.max_records || 100;

      const response = await this.apiClient.post('/compound/similarity/smiles/JSON', {
        smiles: args.smiles,
        Threshold: threshold,
        MaxRecords: maxRecords,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search similar compounds: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleSubstructureSearch(args: any) {
    try {
      const smiles = args.smiles;
      const maxRecords = Math.min(args.max_records || 100, 1000);
      
      if (!smiles) {
        throw new McpError(ErrorCode.InvalidParams, 'SMILES string is required for substructure search');
      }

      const searchData: any = {
        query: {
          smiles: smiles,
          search_type: 'substructure',
          max_records: maxRecords
        },
        results: {
          compounds: [],
          total_found: 0,
          search_time_ms: 0
        },
        search_parameters: {
          match_type: 'substructure',
          stereochemistry: 'ignore',
          tautomers: 'ignore'
        },
        last_updated: new Date().toISOString()
      };

      const startTime = Date.now();

      try {
        // Use PubChem's substructure search endpoint
        const searchResponse = await this.apiClient.post('/compound/substructure/smiles/JSON', 
          `smiles=${encodeURIComponent(smiles)}&MaxRecords=${maxRecords}`, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          }
        });

        if (searchResponse.data?.IdentifierList?.CID) {
          const cids = Array.isArray(searchResponse.data.IdentifierList.CID) 
            ? searchResponse.data.IdentifierList.CID 
            : [searchResponse.data.IdentifierList.CID];

          searchData.results.total_found = cids.length;

          // Get detailed information for found compounds (limit to prevent overload)
          const detailCids = cids.slice(0, Math.min(20, maxRecords));
          
          if (detailCids.length > 0) {
            try {
              const detailResponse = await this.apiClient.get(`/compound/cid/${detailCids.join(',')}/property/MolecularWeight,CanonicalSMILES,IUPACName,MolecularFormula,XLogP,TPSA/JSON`);
              
              if (detailResponse.data?.PropertyTable?.Properties) {
                searchData.results.compounds = detailResponse.data.PropertyTable.Properties.map((prop: any) => ({
                  cid: prop.CID,
                  name: prop.IUPACName || `Compound ${prop.CID}`,
                  smiles: prop.CanonicalSMILES,
                  molecular_formula: prop.MolecularFormula,
                  molecular_weight: prop.MolecularWeight,
                  logp: prop.XLogP,
                  tpsa: prop.TPSA,
                  pubchem_url: `https://pubchem.ncbi.nlm.nih.gov/compound/${prop.CID}`,
                  match_type: 'substructure'
                }));
              }
            } catch (error) {
              // Continue with CID-only results if detailed info fails
              searchData.results.compounds = detailCids.map((cid: number) => ({
                cid: cid,
                name: `Compound ${cid}`,
                pubchem_url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
                match_type: 'substructure'
              }));
            }
          }
        } else {
          searchData.results.total_found = 0;
          searchData.results.compounds = [];
        }

      } catch (error) {
        // Fallback: Try similarity search as approximation
        try {
          const similarityResponse = await this.apiClient.get(`/compound/fastsimilarity_2d/smiles/${encodeURIComponent(smiles)}/JSON?Threshold=95&MaxRecords=${Math.min(maxRecords, 50)}`);
          
          if (similarityResponse.data?.IdentifierList?.CID) {
            const cids = Array.isArray(similarityResponse.data.IdentifierList.CID) 
              ? similarityResponse.data.IdentifierList.CID 
              : [similarityResponse.data.IdentifierList.CID];

            searchData.results.total_found = cids.length;
            searchData.results.compounds = cids.map((cid: number) => ({
              cid: cid,
              name: `Compound ${cid}`,
              pubchem_url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
              match_type: 'similarity_fallback',
              note: 'Similarity search used as substructure fallback'
            }));
            
            searchData.search_parameters.fallback_used = 'similarity_search';
          }
        } catch (fallbackError) {
          searchData.results.total_found = 0;
          searchData.results.compounds = [];
          searchData.error_note = 'Substructure search not available, similarity fallback also failed';
        }
      }

      searchData.results.search_time_ms = Date.now() - startTime;

      // Add analysis insights
      searchData.insights = {
        search_efficiency: searchData.results.total_found > 0 ? 'successful' : 'no_matches',
        compound_diversity: this.assessCompoundDiversity(searchData.results.compounds),
        recommendations: [
          'Use ChEMBL for bioactivity data on substructure matches',
          'Consider structural modifications for lead optimization',
          'Analyze common scaffolds in results',
          'Check patent landscape for similar structures'
        ]
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(searchData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error in substructure search: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Helper method to assess compound diversity
  private assessCompoundDiversity(compounds: any[]): string {
    if (compounds.length === 0) return 'no_compounds';
    if (compounds.length === 1) return 'single_compound';
    
    // Simple diversity assessment based on molecular weight range
    const weights = compounds.filter(c => c.molecular_weight).map(c => c.molecular_weight);
    if (weights.length === 0) return 'unknown';
    
    const minWeight = Math.min(...weights);
    const maxWeight = Math.max(...weights);
    const range = maxWeight - minWeight;
    
    if (range > 200) return 'high_diversity';
    if (range > 100) return 'moderate_diversity';
    return 'low_diversity';
  }

  private async handleSuperstructureSearch(args: any) {
    return { content: [{ type: 'text', text: JSON.stringify({ message: 'Superstructure search not yet implemented', args }, null, 2) }] };
  }

  private async handleGet3dConformers(args: any) {
    if (!isValidConformerArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid 3D conformer arguments');
    }

    try {
      const response = await this.apiClient.get(`/compound/cid/${args.cid}/property/Volume3D,ConformerCount3D/JSON`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              cid: args.cid,
              conformer_type: args.conformer_type || '3d',
              properties: response.data,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get 3D conformers: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleAnalyzeStereochemistry(args: any) {
    if (!isValidCidArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid stereochemistry arguments');
    }

    try {
      const response = await this.apiClient.get(`/compound/cid/${args.cid}/property/AtomStereoCount,DefinedAtomStereoCount,BondStereoCount,DefinedBondStereoCount,IsomericSMILES/JSON`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              cid: args.cid,
              stereochemistry: response.data,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to analyze stereochemistry: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetCompoundProperties(args: any) {
    if (!isValidPropertiesArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid compound properties arguments');
    }

    try {
      const properties = args.properties || [
        'MolecularWeight', 'XLogP', 'TPSA', 'HBondDonorCount', 'HBondAcceptorCount',
        'RotatableBondCount', 'Complexity', 'HeavyAtomCount', 'Charge'
      ];

      const response = await this.apiClient.get(`/compound/cid/${args.cid}/property/${properties.join(',')}/JSON`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get compound properties: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Placeholder implementations for remaining methods
  private async handleCalculateDescriptors(args: any) {
    try {
      const cid = args.cid;
      let smiles = args.smiles;
      const descriptorTypes = args.descriptor_types || ['all'];
      
      if (!cid && !smiles) {
        throw new McpError(ErrorCode.InvalidParams, 'Either CID or SMILES must be provided');
      }

      const descriptorData: any = {
        input: { cid, smiles },
        descriptors: {
          basic_properties: {},
          topological: {},
          geometric: {},
          electronic: {},
          pharmacophore: {},
          fingerprints: {}
        },
        calculated_properties: {},
        metadata: {
          calculation_method: 'pubchem_computed',
          descriptor_count: 0,
          calculation_time_ms: 0
        },
        last_updated: new Date().toISOString()
      };

      const startTime = Date.now();

      // Get comprehensive molecular properties from PubChem
      if (cid) {
        try {
          const propResponse = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularWeight,MolecularFormula,CanonicalSMILES,IUPACName,InChI,InChIKey,XLogP,TPSA,Complexity,Charge,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,HeavyAtomCount,AtomStereoCount,DefinedAtomStereoCount,BondStereoCount,DefinedBondStereoCount,Volume3D,ConformerCount3D/JSON`);
          
          if (propResponse.data?.PropertyTable?.Properties?.[0]) {
            const props = propResponse.data.PropertyTable.Properties[0];
            
            // Basic Properties
            descriptorData.descriptors.basic_properties = {
              molecular_weight: props.MolecularWeight,
              molecular_formula: props.MolecularFormula,
              smiles: props.CanonicalSMILES,
              iupac_name: props.IUPACName,
              inchi: props.InChI,
              inchi_key: props.InChIKey,
              formal_charge: props.Charge
            };

            // Topological Descriptors
            descriptorData.descriptors.topological = {
              heavy_atom_count: props.HeavyAtomCount,
              rotatable_bond_count: props.RotatableBondCount,
              hydrogen_bond_donor_count: props.HBondDonorCount,
              hydrogen_bond_acceptor_count: props.HBondAcceptorCount,
              topological_polar_surface_area: props.TPSA,
              molecular_complexity: props.Complexity
            };

            // Electronic Descriptors
            descriptorData.descriptors.electronic = {
              xlogp: props.XLogP,
              formal_charge: props.Charge
            };

            // Geometric Descriptors (3D)
            if (props.Volume3D !== undefined) {
              descriptorData.descriptors.geometric = {
                volume_3d: props.Volume3D,
                conformer_count_3d: props.ConformerCount3D
              };
            }

            // Stereochemistry
            descriptorData.descriptors.stereochemistry = {
              atom_stereo_count: props.AtomStereoCount,
              defined_atom_stereo_count: props.DefinedAtomStereoCount,
              bond_stereo_count: props.BondStereoCount,
              defined_bond_stereo_count: props.DefinedBondStereoCount
            };

            smiles = props.CanonicalSMILES; // Use for additional calculations
          }
        } catch (error) {
          throw new McpError(ErrorCode.InternalError, `Failed to get molecular properties: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Calculate additional descriptors if SMILES is available
      if (smiles) {
        descriptorData.calculated_properties = this.calculateAdditionalDescriptors(smiles);
      }

      // Calculate derived descriptors
      descriptorData.descriptors.derived = this.calculateDerivedDescriptors(descriptorData.descriptors);

      // Add pharmacophore features
      descriptorData.descriptors.pharmacophore = this.calculatePharmacophoreDescriptors(descriptorData.descriptors);

      // Generate fingerprint information (simplified)
      descriptorData.descriptors.fingerprints = this.generateFingerprintInfo(smiles);

      // Count total descriptors
      let descriptorCount = 0;
      for (const category of Object.values(descriptorData.descriptors)) {
        if (typeof category === 'object' && category !== null) {
          descriptorCount += Object.keys(category).length;
        }
      }
      descriptorData.metadata.descriptor_count = descriptorCount;
      descriptorData.metadata.calculation_time_ms = Date.now() - startTime;

      // Add interpretation and recommendations
      descriptorData.interpretation = this.interpretDescriptors(descriptorData.descriptors);
      descriptorData.recommendations = [
        'Use RDKit for more comprehensive descriptor calculations',
        'Consider 3D descriptors for structure-activity relationships',
        'Analyze descriptor correlations for feature selection',
        'Use descriptors for QSAR model development'
      ];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(descriptorData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error calculating descriptors: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Helper method to calculate additional descriptors from SMILES
  private calculateAdditionalDescriptors(smiles: string): any {
    return {
      smiles_length: smiles.length,
      aromatic_rings: (smiles.match(/c/g) || []).length / 6, // Rough estimate
      aliphatic_rings: (smiles.match(/C/g) || []).length,
      heteroatoms: (smiles.match(/[NOPS]/g) || []).length,
      double_bonds: (smiles.match(/=/g) || []).length,
      triple_bonds: (smiles.match(/#/g) || []).length,
      branching_points: (smiles.match(/\(/g) || []).length,
      note: 'Simplified calculations based on SMILES parsing'
    };
  }

  // Helper method to calculate derived descriptors
  private calculateDerivedDescriptors(descriptors: any): any {
    const basic = descriptors.basic_properties || {};
    const topo = descriptors.topological || {};
    
    return {
      molecular_efficiency_index: basic.molecular_weight ? 
        (topo.heavy_atom_count || 0) / basic.molecular_weight : null,
      lipophilic_efficiency: basic.molecular_weight && descriptors.electronic?.xlogp ? 
        descriptors.electronic.xlogp / basic.molecular_weight * 1000 : null,
      polar_surface_area_ratio: basic.molecular_weight && topo.topological_polar_surface_area ? 
        topo.topological_polar_surface_area / basic.molecular_weight : null,
      rotatable_bond_fraction: topo.heavy_atom_count && topo.rotatable_bond_count ? 
        topo.rotatable_bond_count / topo.heavy_atom_count : null
    };
  }

  // Helper method to calculate pharmacophore descriptors
  private calculatePharmacophoreDescriptors(descriptors: any): any {
    const topo = descriptors.topological || {};
    
    return {
      hydrogen_bond_capacity: (topo.hydrogen_bond_donor_count || 0) + (topo.hydrogen_bond_acceptor_count || 0),
      flexibility_index: topo.rotatable_bond_count || 0,
      polar_interaction_potential: topo.topological_polar_surface_area || 0,
      size_descriptor: topo.heavy_atom_count || 0
    };
  }

  // Helper method to generate fingerprint information
  private generateFingerprintInfo(smiles?: string): any {
    return {
      available_types: ['MACCS', 'Morgan', 'RDKit', 'AtomPairs', 'TopologicalTorsion'],
      note: 'Fingerprint calculation requires specialized cheminformatics libraries',
      recommendation: 'Use RDKit, CDK, or OpenEye for fingerprint generation',
      smiles_provided: !!smiles
    };
  }

  // Helper method to interpret descriptors
  private interpretDescriptors(descriptors: any): any {
    const basic = descriptors.basic_properties || {};
    const topo = descriptors.topological || {};
    const electronic = descriptors.electronic || {};
    
    return {
      drug_likeness: {
        lipinski_compliant: this.assessLipinskiComplianceFromDescriptors(basic, topo, electronic),
        lead_like: this.assessLeadLikenessFromDescriptors(basic, topo, electronic),
        fragment_like: this.assessFragmentLikenessFromDescriptors(basic, topo)
      },
      complexity_assessment: {
        level: topo.molecular_complexity > 500 ? 'high' : 
               topo.molecular_complexity > 200 ? 'moderate' : 'low',
        synthetic_accessibility: topo.molecular_complexity > 400 ? 'challenging' : 'accessible'
      },
      property_alerts: this.generateDescriptorPropertyAlerts(basic, topo, electronic)
    };
  }

  // Helper methods for descriptor interpretation
  private assessLipinskiComplianceFromDescriptors(basic: any, topo: any, electronic: any): boolean {
    return (basic.molecular_weight || 0) <= 500 &&
           (electronic.xlogp || 0) <= 5 &&
           (topo.hydrogen_bond_donor_count || 0) <= 5 &&
           (topo.hydrogen_bond_acceptor_count || 0) <= 10;
  }

  private assessLeadLikenessFromDescriptors(basic: any, topo: any, electronic: any): boolean {
    return (basic.molecular_weight || 0) <= 350 &&
           (electronic.xlogp || 0) <= 3 &&
           (topo.rotatable_bond_count || 0) <= 7;
  }

  private assessFragmentLikenessFromDescriptors(basic: any, topo: any): boolean {
    return (basic.molecular_weight || 0) <= 300 &&
           (topo.heavy_atom_count || 0) <= 22 &&
           (topo.rotatable_bond_count || 0) <= 3;
  }

  private generateDescriptorPropertyAlerts(basic: any, topo: any, electronic: any): string[] {
    const alerts = [];
    
    if ((basic.molecular_weight || 0) > 500) {
      alerts.push('High molecular weight may affect bioavailability');
    }
    
    if ((electronic.xlogp || 0) > 5) {
      alerts.push('High lipophilicity may cause solubility issues');
    }
    
    if ((topo.rotatable_bond_count || 0) > 10) {
      alerts.push('High flexibility may reduce binding selectivity');
    }
    
    if ((topo.topological_polar_surface_area || 0) > 140) {
      alerts.push('High polar surface area may limit membrane permeability');
    }
    
    return alerts;
  }

  // ADMET prediction helper methods
  private predictCaco2Permeability(props: any) {
    const logPeff = props.logp - 0.4 * props.tpsa / 100;
    const permeability = Math.max(0, Math.min(100, 50 + 20 * logPeff));
    return {
      value: Math.round(permeability * 100) / 100,
      unit: '10^-6 cm/s',
      classification: permeability > 20 ? 'High' : permeability > 5 ? 'Moderate' : 'Low',
      confidence: 'Medium'
    };
  }

  private predictHIA(props: any) {
    const hiaScore = props.tpsa < 140 && props.molecular_weight < 500 ? 0.8 : 0.4;
    return {
      probability: hiaScore,
      classification: hiaScore > 0.7 ? 'Well absorbed' : hiaScore > 0.3 ? 'Moderately absorbed' : 'Poorly absorbed',
      confidence: 'Medium'
    };
  }

  private predictBioavailability(props: any) {
    let bioavailability = 0.5;
    if (props.molecular_weight <= 500) bioavailability += 0.2;
    if (props.logp <= 5 && props.logp >= 0) bioavailability += 0.2;
    if (props.tpsa <= 140) bioavailability += 0.1;
    
    return {
      value: Math.min(1.0, bioavailability),
      percentage: Math.round(Math.min(100, bioavailability * 100)),
      classification: bioavailability > 0.7 ? 'High' : bioavailability > 0.3 ? 'Moderate' : 'Low',
      confidence: 'Low'
    };
  }

  private predictPgpSubstrate(props: any) {
    const pgpScore = props.molecular_weight > 400 && props.logp > 3 ? 0.7 : 0.3;
    return {
      probability: pgpScore,
      classification: pgpScore > 0.5 ? 'Likely substrate' : 'Unlikely substrate',
      confidence: 'Low'
    };
  }

  private predictBBBPenetration(props: any) {
    const bbbScore = props.tpsa < 90 && props.molecular_weight < 450 && props.logp > 1 ? 0.7 : 0.2;
    return {
      probability: bbbScore,
      classification: bbbScore > 0.5 ? 'CNS+' : 'CNS-',
      confidence: 'Low'
    };
  }

  private predictVolumeDistribution(props: any) {
    const vd = 0.5 + 0.1 * props.logp;
    return {
      value: Math.max(0.1, vd),
      unit: 'L/kg',
      classification: vd > 3 ? 'High' : vd > 0.7 ? 'Moderate' : 'Low',
      confidence: 'Low'
    };
  }

  private predictProteinBinding(props: any) {
    const binding = Math.min(99, 50 + 10 * props.logp);
    return {
      percentage: Math.max(10, binding),
      classification: binding > 90 ? 'High' : binding > 70 ? 'Moderate' : 'Low',
      confidence: 'Low'
    };
  }

  private predictTissueDistribution(props: any) {
    return {
      brain: props.tpsa < 90 ? 'Moderate' : 'Low',
      liver: 'High',
      kidney: props.molecular_weight < 30000 ? 'High' : 'Low',
      confidence: 'Low'
    };
  }

  private predictCYPSubstrate(props: any) {
    return {
      cyp3a4: props.molecular_weight > 300 ? 'Likely' : 'Unlikely',
      cyp2d6: props.molecular_weight < 400 ? 'Possible' : 'Unlikely',
      cyp2c9: 'Possible',
      confidence: 'Low'
    };
  }

  private predictCYPInhibition(props: any) {
    return {
      cyp3a4: props.logp > 3 ? 'Possible' : 'Unlikely',
      cyp2d6: 'Unlikely',
      cyp2c9: 'Unlikely',
      confidence: 'Low'
    };
  }

  private predictMetabolicStability(props: any) {
    const stability = props.complexity < 200 ? 'High' : props.complexity < 400 ? 'Moderate' : 'Low';
    return {
      classification: stability,
      half_life_estimate: stability === 'High' ? '> 60 min' : stability === 'Moderate' ? '30-60 min' : '< 30 min',
      confidence: 'Low'
    };
  }

  private predictFirstPassMetabolism(props: any) {
    return {
      extent: props.logp > 2 ? 'High' : 'Low',
      confidence: 'Low'
    };
  }

  private predictRenalClearance(props: any) {
    const clearance = props.molecular_weight < 30000 ? 'High' : 'Low';
    return {
      classification: clearance,
      confidence: 'Low'
    };
  }

  private predictHalfLife(props: any) {
    const halfLife = 2 + props.molecular_weight / 200;
    return {
      value: Math.round(halfLife * 10) / 10,
      unit: 'hours',
      classification: halfLife > 12 ? 'Long' : halfLife > 4 ? 'Moderate' : 'Short',
      confidence: 'Low'
    };
  }

  private predictEliminationRoute(props: any) {
    return {
      primary: props.molecular_weight < 500 ? 'Renal' : 'Hepatic',
      secondary: 'Biliary',
      confidence: 'Low'
    };
  }

  private predictAmesMutagenicity(props: any, smiles?: string) {
    let mutagenic = false;
    if (smiles) {
      // Basic structural alerts
      const alerts = ['N=N', 'N-N=O', 'C=C-C=C', 'c1ccc2c(c1)ccc3c2ccc4c3cccc4'];
      mutagenic = alerts.some(alert => smiles.includes(alert));
    }
    return {
      prediction: mutagenic ? 'Positive' : 'Negative',
      confidence: 'Low'
    };
  }

  private predictHepatotoxicity(props: any) {
    const toxic = props.logp > 5 || props.molecular_weight > 600;
    return {
      prediction: toxic ? 'Possible' : 'Unlikely',
      confidence: 'Low'
    };
  }

  private predictCardiotoxicity(props: any) {
    return {
      herg_inhibition: props.logp > 4 ? 'Possible' : 'Unlikely',
      qt_prolongation: 'Unlikely',
      confidence: 'Low'
    };
  }

  private predictSkinSensitization(props: any) {
    return {
      prediction: 'Unlikely',
      confidence: 'Low'
    };
  }

  private predictAcuteToxicity(props: any) {
    const ld50 = Math.max(50, 2000 - props.logp * 200);
    return {
      ld50_estimate: Math.round(ld50),
      unit: 'mg/kg',
      classification: ld50 > 2000 ? 'Low toxicity' : ld50 > 300 ? 'Moderate toxicity' : 'High toxicity',
      confidence: 'Low'
    };
  }

  private estimateClearance(props: any) {
    const clearance = 20 - props.logp * 2;
    return {
      value: Math.max(1, clearance),
      unit: 'mL/min/kg',
      confidence: 'Low'
    };
  }

  private predictDoseRange(props: any) {
    const dose = props.molecular_weight / 10;
    return {
      low: Math.round(dose / 10),
      high: Math.round(dose),
      unit: 'mg',
      confidence: 'Very Low'
    };
  }

  private generateADMETAlerts(predictions: any, props: any): string[] {
    const alerts = [];
    
    if (predictions.absorption.bioavailability_f.value < 0.3) {
      alerts.push('Low predicted bioavailability');
    }
    
    if (predictions.toxicity.hepatotoxicity.prediction === 'Possible') {
      alerts.push('Potential hepatotoxicity risk');
    }
    
    if (props.molecular_weight > 500) {
      alerts.push('High molecular weight may affect absorption');
    }
    
    if (props.logp > 5) {
      alerts.push('High lipophilicity may cause solubility issues');
    }
    
    return alerts;
  }

  private calculateADMETScore(predictions: any): number {
    let score = 50; // Base score
    
    // Absorption
    if (predictions.absorption.bioavailability_f.value > 0.7) score += 15;
    else if (predictions.absorption.bioavailability_f.value > 0.3) score += 5;
    
    // Distribution
    if (predictions.distribution.protein_binding.percentage < 90) score += 10;
    
    // Toxicity
    if (predictions.toxicity.hepatotoxicity.prediction === 'Unlikely') score += 15;
    if (predictions.toxicity.ames_mutagenicity.prediction === 'Negative') score += 10;
    
    return Math.min(100, Math.max(0, score));
  }

  private assessDevelopability(score: number): string {
    if (score >= 80) return 'Excellent';
    if (score >= 65) return 'Good';
    if (score >= 50) return 'Moderate';
    if (score >= 35) return 'Poor';
    return 'Very Poor';
  }

  private identifyKeyConcerns(predictions: any): string[] {
    const concerns = [];
    
    if (predictions.absorption.bioavailability_f.value < 0.3) {
      concerns.push('Poor oral bioavailability');
    }
    
    if (predictions.toxicity.hepatotoxicity.prediction === 'Possible') {
      concerns.push('Hepatotoxicity risk');
    }
    
    if (predictions.metabolism.metabolic_stability.classification === 'Low') {
      concerns.push('Rapid metabolism');
    }
    
    return concerns;
  }

  private generateADMETRecommendations(predictions: any, props: any): string[] {
    const recommendations = [];
    
    if (predictions.absorption.bioavailability_f.value < 0.5) {
      recommendations.push('Consider formulation strategies to improve bioavailability');
    }
    
    if (props.molecular_weight > 500) {
      recommendations.push('Reduce molecular weight to improve drug-like properties');
    }
    
    if (props.logp > 5) {
      recommendations.push('Reduce lipophilicity to improve solubility');
    }
    
    if (predictions.toxicity.hepatotoxicity.prediction === 'Possible') {
      recommendations.push('Conduct hepatotoxicity studies early in development');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('ADMET profile appears favorable for development');
    }
    
    return recommendations;
  }

  private async handlePredictAdmetProperties(args: any) {
    try {
      let cid = args.cid;
      let smiles = args.smiles;

      if (!cid && !smiles) {
        throw new McpError(ErrorCode.InvalidParams, 'Either CID or SMILES must be provided');
      }

      const admetData: any = {
        input: { cid, smiles },
        molecular_properties: {},
        admet_predictions: {
          absorption: {},
          distribution: {},
          metabolism: {},
          excretion: {},
          toxicity: {}
        },
        pharmacokinetic_parameters: {},
        alerts_and_warnings: [],
        overall_profile: {
          admet_score: 0,
          developability: 'Unknown',
          key_concerns: [],
          recommendations: []
        },
        disclaimer: 'Predictions based on molecular properties - experimental validation required',
        last_updated: new Date().toISOString()
      };

      // Get comprehensive molecular properties
      if (cid) {
        try {
          const propResponse = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularWeight,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,HeavyAtomCount,Complexity,CanonicalSMILES,MolecularFormula/JSON`);
          
          if (propResponse.data?.PropertyTable?.Properties?.[0]) {
            const props = propResponse.data.PropertyTable.Properties[0];
            admetData.molecular_properties = {
              molecular_weight: props.MolecularWeight,
              logp: props.XLogP,
              tpsa: props.TPSA,
              hbd_count: props.HBondDonorCount,
              hba_count: props.HBondAcceptorCount,
              rotatable_bonds: props.RotatableBondCount,
              heavy_atoms: props.HeavyAtomCount,
              complexity: props.Complexity,
              smiles: props.CanonicalSMILES,
              molecular_formula: props.MolecularFormula
            };
            smiles = props.CanonicalSMILES;
          }
        } catch (error) {
          throw new McpError(ErrorCode.InternalError, `Failed to get molecular properties: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      const props = admetData.molecular_properties;

      // ABSORPTION predictions
      admetData.admet_predictions.absorption = {
        caco2_permeability: this.predictCaco2Permeability(props),
        hia_human_intestinal_absorption: this.predictHIA(props),
        bioavailability_f: this.predictBioavailability(props),
        pgp_substrate: this.predictPgpSubstrate(props),
        bbb_penetration: this.predictBBBPenetration(props)
      };

      // DISTRIBUTION predictions
      admetData.admet_predictions.distribution = {
        vd_volume_distribution: this.predictVolumeDistribution(props),
        protein_binding: this.predictProteinBinding(props),
        tissue_distribution: this.predictTissueDistribution(props)
      };

      // METABOLISM predictions
      admetData.admet_predictions.metabolism = {
        cyp_substrate: this.predictCYPSubstrate(props),
        cyp_inhibition: this.predictCYPInhibition(props),
        metabolic_stability: this.predictMetabolicStability(props),
        first_pass_metabolism: this.predictFirstPassMetabolism(props)
      };

      // EXCRETION predictions
      admetData.admet_predictions.excretion = {
        renal_clearance: this.predictRenalClearance(props),
        half_life: this.predictHalfLife(props),
        elimination_route: this.predictEliminationRoute(props)
      };

      // TOXICITY predictions
      admetData.admet_predictions.toxicity = {
        ames_mutagenicity: this.predictAmesMutagenicity(props, smiles),
        hepatotoxicity: this.predictHepatotoxicity(props),
        cardiotoxicity: this.predictCardiotoxicity(props),
        skin_sensitization: this.predictSkinSensitization(props),
        acute_toxicity: this.predictAcuteToxicity(props)
      };

      // Pharmacokinetic parameters
      admetData.pharmacokinetic_parameters = {
        estimated_clearance: this.estimateClearance(props),
        estimated_bioavailability: admetData.admet_predictions.absorption.bioavailability_f.value,
        estimated_half_life: admetData.admet_predictions.excretion.half_life.value,
        dose_prediction: this.predictDoseRange(props)
      };

      // Generate alerts and warnings
      admetData.alerts_and_warnings = this.generateADMETAlerts(admetData.admet_predictions, props);

      // Overall ADMET assessment
      const admetScore = this.calculateADMETScore(admetData.admet_predictions);
      admetData.overall_profile = {
        admet_score: admetScore,
        developability: this.assessDevelopability(admetScore),
        key_concerns: this.identifyKeyConcerns(admetData.admet_predictions),
        recommendations: this.generateADMETRecommendations(admetData.admet_predictions, props)
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(admetData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error predicting ADMET properties: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleAssessDrugLikeness(args: any) {
    try {
      let cid = args.cid;
      let smiles = args.smiles;

      if (!cid && !smiles) {
        throw new McpError(ErrorCode.InvalidParams, 'Either CID or SMILES must be provided');
      }

      const drugLikenessData: any = {
        input: { cid, smiles },
        molecular_properties: {},
        drug_likeness_rules: {
          lipinski_rule_of_five: {},
          veber_rules: {},
          egan_rules: {},
          ghose_filter: {},
          muegge_rules: {}
        },
        pains_alerts: {
          checked: false,
          alerts: []
        },
        synthetic_accessibility: {},
        overall_assessment: {
          drug_like: false,
          lead_like: false,
          fragment_like: false,
          violations: [],
          recommendations: []
        },
        last_updated: new Date().toISOString()
      };

      // Get molecular properties
      if (cid) {
        try {
          const propResponse = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularWeight,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,HeavyAtomCount,Complexity,CanonicalSMILES/JSON`);
          
          if (propResponse.data?.PropertyTable?.Properties?.[0]) {
            const props = propResponse.data.PropertyTable.Properties[0];
            drugLikenessData.molecular_properties = {
              molecular_weight: props.MolecularWeight,
              logp: props.XLogP,
              tpsa: props.TPSA,
              hbd_count: props.HBondDonorCount,
              hba_count: props.HBondAcceptorCount,
              rotatable_bonds: props.RotatableBondCount,
              heavy_atoms: props.HeavyAtomCount,
              complexity: props.Complexity,
              smiles: props.CanonicalSMILES
            };
            smiles = props.CanonicalSMILES; // Use for further analysis
          }
        } catch (error) {
          throw new McpError(ErrorCode.InternalError, `Failed to get molecular properties: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      const props = drugLikenessData.molecular_properties;

      // Lipinski Rule of Five
      if (props.molecular_weight !== undefined) {
        drugLikenessData.drug_likeness_rules.lipinski_rule_of_five = {
          molecular_weight: {
            value: props.molecular_weight,
            limit: '≤ 500 Da',
            passes: props.molecular_weight <= 500
          },
          logp: {
            value: props.logp,
            limit: '≤ 5',
            passes: props.logp !== undefined ? props.logp <= 5 : null
          },
          hbd_count: {
            value: props.hbd_count,
            limit: '≤ 5',
            passes: props.hbd_count !== undefined ? props.hbd_count <= 5 : null
          },
          hba_count: {
            value: props.hba_count,
            limit: '≤ 10',
            passes: props.hba_count !== undefined ? props.hba_count <= 10 : null
          }
        };

        const lipinskiViolations = Object.values(drugLikenessData.drug_likeness_rules.lipinski_rule_of_five)
          .filter((rule: any) => rule.passes === false).length;
        
        drugLikenessData.drug_likeness_rules.lipinski_rule_of_five.violations = lipinskiViolations;
        drugLikenessData.drug_likeness_rules.lipinski_rule_of_five.passes = lipinskiViolations <= 1; // Allow 1 violation
      }

      // Veber Rules (for oral bioavailability)
      if (props.tpsa !== undefined && props.rotatable_bonds !== undefined) {
        drugLikenessData.drug_likeness_rules.veber_rules = {
          tpsa: {
            value: props.tpsa,
            limit: '≤ 140 Ų',
            passes: props.tpsa <= 140
          },
          rotatable_bonds: {
            value: props.rotatable_bonds,
            limit: '≤ 10',
            passes: props.rotatable_bonds <= 10
          }
        };

        const veberViolations = Object.values(drugLikenessData.drug_likeness_rules.veber_rules)
          .filter((rule: any) => rule.passes === false).length;
        
        drugLikenessData.drug_likeness_rules.veber_rules.violations = veberViolations;
        drugLikenessData.drug_likeness_rules.veber_rules.passes = veberViolations === 0;
      }

      // Egan Rules (alternative to Lipinski)
      if (props.tpsa !== undefined && props.logp !== undefined) {
        drugLikenessData.drug_likeness_rules.egan_rules = {
          tpsa: {
            value: props.tpsa,
            limit: '≤ 131.6 Ų',
            passes: props.tpsa <= 131.6
          },
          logp: {
            value: props.logp,
            limit: '-2 to 6',
            passes: props.logp >= -2 && props.logp <= 6
          }
        };

        const eganViolations = Object.values(drugLikenessData.drug_likeness_rules.egan_rules)
          .filter((rule: any) => rule.passes === false).length;
        
        drugLikenessData.drug_likeness_rules.egan_rules.violations = eganViolations;
        drugLikenessData.drug_likeness_rules.egan_rules.passes = eganViolations === 0;
      }

      // Ghose Filter
      if (props.molecular_weight !== undefined && props.logp !== undefined && props.heavy_atoms !== undefined) {
        drugLikenessData.drug_likeness_rules.ghose_filter = {
          molecular_weight: {
            value: props.molecular_weight,
            limit: '160-480 Da',
            passes: props.molecular_weight >= 160 && props.molecular_weight <= 480
          },
          logp: {
            value: props.logp,
            limit: '-0.4 to 5.6',
            passes: props.logp >= -0.4 && props.logp <= 5.6
          },
          heavy_atoms: {
            value: props.heavy_atoms,
            limit: '20-70',
            passes: props.heavy_atoms >= 20 && props.heavy_atoms <= 70
          }
        };

        const ghoseViolations = Object.values(drugLikenessData.drug_likeness_rules.ghose_filter)
          .filter((rule: any) => rule.passes === false).length;
        
        drugLikenessData.drug_likeness_rules.ghose_filter.violations = ghoseViolations;
        drugLikenessData.drug_likeness_rules.ghose_filter.passes = ghoseViolations === 0;
      }

      // Basic PAINS assessment (simplified)
      if (smiles) {
        drugLikenessData.pains_alerts = {
          checked: true,
          alerts: this.checkBasicPAINS(smiles),
          note: 'Basic PAINS check - use specialized tools for comprehensive analysis'
        };
      }

      // Synthetic Accessibility (basic estimation)
      if (props.complexity !== undefined) {
        drugLikenessData.synthetic_accessibility = {
          complexity_score: props.complexity,
          estimated_difficulty: this.estimateSyntheticDifficulty(props.complexity),
          note: 'Based on PubChem complexity score - use specialized SA tools for accurate assessment'
        };
      }

      // Overall Assessment
      const lipinskiPasses = drugLikenessData.drug_likeness_rules.lipinski_rule_of_five?.passes;
      const veberPasses = drugLikenessData.drug_likeness_rules.veber_rules?.passes;
      const painsAlerts = drugLikenessData.pains_alerts.alerts?.length || 0;

      drugLikenessData.overall_assessment = {
        drug_like: lipinskiPasses && veberPasses && painsAlerts === 0,
        lead_like: this.assessLeadLikeness(props),
        fragment_like: this.assessFragmentLikeness(props),
        violations: this.collectViolations(drugLikenessData.drug_likeness_rules),
        pains_alerts_count: painsAlerts,
        recommendations: this.generateDrugLikenessRecommendations(drugLikenessData)
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(drugLikenessData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error assessing drug-likeness: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Helper methods for drug-likeness assessment
  private checkBasicPAINS(smiles: string): string[] {
    const alerts = [];
    const painsPatterns = [
      { pattern: /C=C-C=C/, name: 'Conjugated diene' },
      { pattern: /N-N/, name: 'Hydrazine' },
      { pattern: /S-S/, name: 'Disulfide' },
      { pattern: /C#C/, name: 'Alkyne' },
      { pattern: /\[N\+\]/, name: 'Quaternary nitrogen' }
    ];

    for (const pains of painsPatterns) {
      if (pains.pattern.test(smiles)) {
        alerts.push(pains.name);
      }
    }
    return alerts;
  }

  private estimateSyntheticDifficulty(complexity: number): string {
    if (complexity < 100) return 'Easy';
    if (complexity < 300) return 'Moderate';
    if (complexity < 500) return 'Difficult';
    return 'Very Difficult';
  }

  private assessLeadLikeness(props: any): boolean {
    return props.molecular_weight <= 350 && 
           props.logp <= 3 && 
           props.rotatable_bonds <= 7;
  }

  private assessFragmentLikeness(props: any): boolean {
    return props.molecular_weight <= 300 && 
           props.heavy_atoms <= 22 && 
           props.rotatable_bonds <= 3;
  }

  private collectViolations(rules: any): string[] {
    const violations = [];
    for (const [ruleName, ruleData] of Object.entries(rules)) {
      if (ruleData && typeof ruleData === 'object' && 'violations' in ruleData) {
        const violations_count = (ruleData as any).violations;
        if (typeof violations_count === 'number' && violations_count > 0) {
          violations.push(`${ruleName}: ${violations_count} violation(s)`);
        }
      }
    }
    return violations;
  }

  private generateDrugLikenessRecommendations(data: any): string[] {
    const recommendations = [];
    
    if (data.overall_assessment.pains_alerts_count > 0) {
      recommendations.push('Consider removing or modifying PAINS-flagged substructures');
    }
    
    if (data.molecular_properties.molecular_weight > 500) {
      recommendations.push('Reduce molecular weight to improve drug-likeness');
    }
    
    if (data.molecular_properties.logp > 5) {
      recommendations.push('Reduce lipophilicity to improve solubility');
    }
    
    if (data.molecular_properties.rotatable_bonds > 10) {
      recommendations.push('Reduce rotatable bonds to improve oral bioavailability');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('Compound shows good drug-likeness properties');
    }
    
    return recommendations;
  }



  private async handleAnalyzeMolecularComplexity(args: any) {
    try {
      const cid = args.cid;
      let smiles = args.smiles;
      
      if (!cid && !smiles) {
        throw new McpError(ErrorCode.InvalidParams, 'Either CID or SMILES must be provided');
      }

      const complexityData: any = {
        input: { cid, smiles },
        complexity_metrics: {
          pubchem_complexity: null,
          structural_complexity: {},
          synthetic_complexity: {},
          topological_complexity: {}
        },
        complexity_analysis: {
          overall_score: 0,
          complexity_level: 'unknown',
          contributing_factors: [],
          simplification_suggestions: []
        },
        benchmarking: {
          percentile_rank: null,
          similar_complexity_compounds: []
        },
        last_updated: new Date().toISOString()
      };

      // Get molecular properties including complexity from PubChem
      if (cid) {
        try {
          const propResponse = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularWeight,CanonicalSMILES,Complexity,HeavyAtomCount,RotatableBondCount/JSON`);
          
          if (propResponse.data?.PropertyTable?.Properties?.[0]) {
            const props = propResponse.data.PropertyTable.Properties[0];
            
            complexityData.complexity_metrics.pubchem_complexity = props.Complexity;
            smiles = props.CanonicalSMILES;
            
            // Analyze structural complexity
            complexityData.complexity_metrics.structural_complexity = {
              heavy_atom_count: props.HeavyAtomCount,
              molecular_weight: props.MolecularWeight,
              rotatable_bonds: props.RotatableBondCount
            };
          }
        } catch (error) {
          throw new McpError(ErrorCode.InternalError, `Failed to get molecular properties: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Analyze SMILES-based complexity if available
      if (smiles) {
        complexityData.complexity_metrics.topological_complexity = this.analyzeSmilesComplexity(smiles);
        complexityData.complexity_metrics.synthetic_complexity = this.estimateSyntheticComplexity(smiles);
      }

      // Calculate overall complexity score
      const overallScore = this.calculateOverallComplexityScore(complexityData.complexity_metrics);
      complexityData.complexity_analysis.overall_score = overallScore;
      complexityData.complexity_analysis.complexity_level = this.categorizeComplexity(overallScore);

      // Identify contributing factors
      complexityData.complexity_analysis.contributing_factors = this.identifyComplexityFactors(complexityData.complexity_metrics);

      // Generate simplification suggestions
      complexityData.complexity_analysis.simplification_suggestions = this.generateSimplificationSuggestions(complexityData.complexity_metrics);

      // Estimate percentile rank
      if (complexityData.complexity_metrics.pubchem_complexity) {
        complexityData.benchmarking.percentile_rank = this.estimateComplexityPercentile(complexityData.complexity_metrics.pubchem_complexity);
      }

      // Add recommendations
      complexityData.recommendations = [
        'Consider structural simplification for improved synthetic accessibility',
        'Analyze complexity vs activity relationships',
        'Use fragment-based approaches for complex molecules',
        'Consider prodrug strategies for complex active compounds'
      ];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(complexityData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error analyzing molecular complexity: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Helper method to analyze SMILES complexity
  private analyzeSmilesComplexity(smiles: string): any {
    return {
      smiles_length: smiles.length,
      unique_atoms: new Set(smiles.match(/[A-Z]/g) || []).size,
      branching_points: (smiles.match(/\(/g) || []).length,
      ring_closures: (smiles.match(/\d/g) || []).length,
      double_bonds: (smiles.match(/=/g) || []).length,
      triple_bonds: (smiles.match(/#/g) || []).length,
      aromatic_atoms: (smiles.match(/[a-z]/g) || []).length,
      stereochemistry_centers: (smiles.match(/@/g) || []).length,
      complexity_score: this.calculateSmilesComplexityScore(smiles)
    };
  }

  // Helper method to estimate synthetic complexity
  private estimateSyntheticComplexity(smiles: string): any {
    const rings = (smiles.match(/\d/g) || []).length / 2; // Rough ring count
    const stereocenters = (smiles.match(/@/g) || []).length;
    const heteroatoms = (smiles.match(/[NOPS]/g) || []).length;
    const functionalGroups = this.countFunctionalGroups(smiles);
    
    const syntheticScore = rings * 2 + stereocenters * 3 + heteroatoms * 1.5 + functionalGroups * 2;
    
    return {
      estimated_steps: Math.min(20, Math.max(1, Math.round(syntheticScore / 5))),
      ring_formations: rings,
      stereochemistry_challenges: stereocenters,
      functional_group_installations: functionalGroups,
      heteroatom_incorporations: heteroatoms,
      synthetic_accessibility: syntheticScore < 10 ? 'easy' : syntheticScore < 25 ? 'moderate' : 'challenging',
      estimated_score: syntheticScore
    };
  }

  // Helper method to calculate SMILES complexity score
  private calculateSmilesComplexityScore(smiles: string): number {
    let score = 0;
    score += smiles.length * 0.1; // Length penalty
    score += (smiles.match(/\(/g) || []).length * 2; // Branching penalty
    score += (smiles.match(/\d/g) || []).length * 1.5; // Ring penalty
    score += (smiles.match(/@/g) || []).length * 3; // Stereochemistry penalty
    score += (smiles.match(/[NOPS]/g) || []).length * 1; // Heteroatom penalty
    return Math.round(score * 10) / 10;
  }

  // Helper method to count functional groups
  private countFunctionalGroups(smiles: string): number {
    const functionalGroups = [
      /C\(=O\)O/g,    // Carboxylic acid
      /C\(=O\)N/g,    // Amide
      /C=O/g,         // Carbonyl
      /O-/g,          // Ether/alcohol
      /N/g,           // Amine
      /S/g,           // Sulfur
      /P/g            // Phosphorus
    ];
    
    let count = 0;
    for (const pattern of functionalGroups) {
      const matches = smiles.match(pattern);
      if (matches) count += matches.length;
    }
    return count;
  }

  // Helper method to calculate overall complexity score
  private calculateOverallComplexityScore(metrics: any): number {
    let score = 0;
    let factors = 0;
    
    if (metrics.pubchem_complexity) {
      score += metrics.pubchem_complexity;
      factors++;
    }
    
    if (metrics.topological_complexity?.complexity_score) {
      score += metrics.topological_complexity.complexity_score * 10;
      factors++;
    }
    
    if (metrics.synthetic_complexity?.estimated_score) {
      score += metrics.synthetic_complexity.estimated_score * 5;
      factors++;
    }
    
    return factors > 0 ? Math.round(score / factors) : 0;
  }

  // Helper method to categorize complexity
  private categorizeComplexity(score: number): string {
    if (score < 100) return 'low';
    if (score < 300) return 'moderate';
    if (score < 500) return 'high';
    return 'very_high';
  }

  // Helper method to identify complexity factors
  private identifyComplexityFactors(metrics: any): string[] {
    const factors = [];
    
    const structural = metrics.structural_complexity || {};
    const topological = metrics.topological_complexity || {};
    const synthetic = metrics.synthetic_complexity || {};
    
    if (structural.rotatable_bonds > 8) {
      factors.push('High molecular flexibility');
    }
    
    if (topological.stereochemistry_centers > 2) {
      factors.push('Multiple stereochemistry centers');
    }
    
    if (synthetic.functional_group_installations > 5) {
      factors.push('Multiple functional groups');
    }
    
    if (structural.heavy_atom_count > 30) {
      factors.push('Large molecular size');
    }
    
    return factors;
  }

  // Helper method to generate simplification suggestions
  private generateSimplificationSuggestions(metrics: any): string[] {
    const suggestions = [];
    
    const structural = metrics.structural_complexity || {};
    const synthetic = metrics.synthetic_complexity || {};
    
    if (structural.rotatable_bonds > 8) {
      suggestions.push('Consider reducing rotatable bonds through cyclization');
    }
    
    if (synthetic.stereochemistry_challenges > 3) {
      suggestions.push('Reduce stereochemical complexity or use stereoselective synthesis');
    }
    
    
    if (structural.molecular_weight > 500) {
      suggestions.push('Consider molecular weight reduction strategies');
    }
    
    if (suggestions.length === 0) {
      suggestions.push('Molecule shows reasonable complexity for its size');
    }
    
    return suggestions;
  }

  // Helper method to estimate complexity percentile
  private estimateComplexityPercentile(complexity: number): number {
    // Rough percentile estimation based on typical PubChem complexity distribution
    if (complexity < 50) return 10;
    if (complexity < 100) return 25;
    if (complexity < 200) return 50;
    if (complexity < 400) return 75;
    if (complexity < 600) return 90;
    return 95;
  }

  private async handleGetPharmacophoreFeatures(args: any) {
    return { content: [{ type: 'text', text: JSON.stringify({ message: 'Pharmacophore features not yet implemented', args }, null, 2) }] };
  }

  private async handleSearchBioassays(args: any) {
    try {
      const query = args.query || '';
      const target = args.target || '';
      const source = args.source || '';
      const maxRecords = args.max_records || 100;

      let searchResults = [];

      // Search by target if provided
      if (target) {
        try {
          const targetResponse = await this.apiClient.get(`/assay/target/${encodeURIComponent(target)}/aids/JSON`, {
            params: { MaxRecords: maxRecords }
          });
          
          if (targetResponse.data?.IdentifierList?.AID) {
            const aids = targetResponse.data.IdentifierList.AID.slice(0, 10);
            
            // Get details for the first few assays
            for (const aid of aids) {
              try {
                const assayDetail = await this.apiClient.get(`/assay/aid/${aid}/summary/JSON`);
                if (assayDetail.data?.AssaySummaries?.[0]) {
                  searchResults.push({
                    aid: aid,
                    target: target,
                    details: assayDetail.data.AssaySummaries[0]
                  });
                }
              } catch (error) {
                // Skip individual assay errors
              }
            }
          }
        } catch (error) {
          // Target search failed, continue with other methods
        }
      }

      // General text search if query provided
      if (query && searchResults.length < 5) {
        try {
          const textResponse = await this.apiClient.get(`/assay/name/${encodeURIComponent(query)}/aids/JSON`, {
            params: { MaxRecords: Math.min(maxRecords, 20) }
          });
          
          if (textResponse.data?.IdentifierList?.AID) {
            const aids = textResponse.data.IdentifierList.AID.slice(0, 5);
            
            for (const aid of aids) {
              try {
                const assayDetail = await this.apiClient.get(`/assay/aid/${aid}/summary/JSON`);
                if (assayDetail.data?.AssaySummaries?.[0]) {
                  searchResults.push({
                    aid: aid,
                    query: query,
                    details: assayDetail.data.AssaySummaries[0]
                  });
                }
              } catch (error) {
                // Skip individual assay errors
              }
            }
          }
        } catch (error) {
          // Text search failed
        }
      }

      // If no specific search, get some popular assays
      if (searchResults.length === 0) {
        const popularAids = [1030, 1159, 1454, 588342, 652065]; // Some well-known assays
        
        for (const aid of popularAids) {
          try {
            const assayDetail = await this.apiClient.get(`/assay/aid/${aid}/summary/JSON`);
            if (assayDetail.data?.AssaySummaries?.[0]) {
              searchResults.push({
                aid: aid,
                type: 'popular_assay',
                details: assayDetail.data.AssaySummaries[0]
              });
            }
          } catch (error) {
            // Skip individual assay errors
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              search_parameters: { query, target, source, max_records: maxRecords },
              total_found: searchResults.length,
              bioassays: searchResults,
              note: 'Results limited to prevent API overload. Use specific target or query for better results.'
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching bioassays: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleGetAssayInfo(args: any) {
    try {
      const response = await this.apiClient.get(`/assay/aid/${args.aid}/JSON`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get assay info: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetCompoundBioactivities(args: any) {
    if (!isValidBioactivityArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid bioactivity arguments');
    }

    try {
      const cid = args.cid;
      const activityOutcome = args.activity_outcome || 'all';
      
      const bioactivityData: any = {
        cid: cid,
        activity_outcome_filter: activityOutcome,
        bioactivities: [],
        summary: {
          total_assays: 0,
          active_assays: 0,
          inactive_assays: 0,
          inconclusive_assays: 0
        },
        data_sources: [],
        last_updated: new Date().toISOString()
      };

      // Get assay IDs where this compound was tested
      try {
        const assayResponse = await this.apiClient.get(`/compound/cid/${cid}/assaysummary/JSON`);
        
        if (assayResponse.data?.Table?.Row) {
          const assayRows = Array.isArray(assayResponse.data.Table.Row) 
            ? assayResponse.data.Table.Row 
            : [assayResponse.data.Table.Row];

          bioactivityData.summary.total_assays = assayRows.length;

          // Process each assay result
          for (const row of assayRows.slice(0, 20)) { // Limit to first 20 for performance
            try {
              const cells = row.Cell;
              const aid = cells[0]; // First cell is usually AID
              const outcome = cells[1] || 'Unknown'; // Second cell is usually outcome
              const potency = cells[2] || null; // Third cell might be potency
              
              // Count outcomes
              const outcomeStr = String(outcome).toLowerCase();
              if (outcomeStr.includes('active')) {
                bioactivityData.summary.active_assays++;
              } else if (outcomeStr.includes('inactive')) {
                bioactivityData.summary.inactive_assays++;
              } else {
                bioactivityData.summary.inconclusive_assays++;
              }

              // Filter by activity outcome if specified
              if (activityOutcome !== 'all') {
                if (!outcomeStr.includes(activityOutcome.toLowerCase())) {
                  continue;
                }
              }

              // Get additional assay details
              let assayDetails = null;
              try {
                const detailResponse = await this.apiClient.get(`/assay/aid/${aid}/summary/JSON`);
                assayDetails = detailResponse.data?.AssaySummaries?.[0];
              } catch (error) {
                // Skip if assay details not available
              }

              bioactivityData.bioactivities.push({
                aid: aid,
                outcome: outcome,
                potency: potency,
                assay_details: assayDetails ? {
                  name: assayDetails.Name,
                  description: assayDetails.Description,
                  target: assayDetails.Target,
                  source: assayDetails.SourceName
                } : null
              });

            } catch (error) {
              // Skip individual assay processing errors
            }
          }

          bioactivityData.data_sources.push('PubChem Assay Summary');
        }
      } catch (error) {
        // Assay summary not available, try alternative approach
      }

      // If no bioactivity data found, try to get at least basic compound info
      if (bioactivityData.bioactivities.length === 0) {
        try {
          const compoundResponse = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularWeight,CanonicalSMILES,IUPACName/JSON`);
          if (compoundResponse.data?.PropertyTable?.Properties?.[0]) {
            bioactivityData.compound_info = compoundResponse.data.PropertyTable.Properties[0];
            bioactivityData.note = 'No bioactivity data found in PubChem for this compound';
          }
        } catch (error) {
          bioactivityData.note = 'Compound not found or no bioactivity data available';
        }
      }

      // Add recommendations for finding more bioactivity data
      bioactivityData.recommendations = [
        'Check ChEMBL database for additional bioactivity data',
        'Search BindingDB for binding affinity measurements',
        'Consider checking compound synonyms for alternative entries',
        'Look for related compounds with similar structures'
      ];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(bioactivityData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting compound bioactivities: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleSearchByTarget(args: any) {
    try {
      const target = args.target;
      const activityType = args.activity_type || '';
      const maxRecords = args.max_records || 100;

      if (!target || typeof target !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Target name is required');
      }

      const targetResults: any = {
        target: target,
        activity_type: activityType,
        compounds: [],
        assays: [],
        summary: {
          total_compounds: 0,
          total_assays: 0,
          activity_types_found: []
        },
        last_updated: new Date().toISOString()
      };

      try {
        // Search for assays related to this target
        const assayResponse = await this.apiClient.get(`/assay/target/${encodeURIComponent(target)}/aids/JSON`, {
          params: { MaxRecords: Math.min(maxRecords, 50) }
        });

        if (assayResponse.data?.IdentifierList?.AID) {
          const aids = assayResponse.data.IdentifierList.AID.slice(0, 10);
          targetResults.summary.total_assays = aids.length;

          // Get details for each assay and find active compounds
          for (const aid of aids) {
            try {
              // Get assay summary
              const assayDetail = await this.apiClient.get(`/assay/aid/${aid}/summary/JSON`);
              if (assayDetail.data?.AssaySummaries?.[0]) {
                const assayInfo = assayDetail.data.AssaySummaries[0];
                
                targetResults.assays.push({
                  aid: aid,
                  name: assayInfo.Name,
                  description: assayInfo.Description,
                  target: assayInfo.Target,
                  source: assayInfo.SourceName
                });

                // Get active compounds for this assay
                try {
                  const activeResponse = await this.apiClient.get(`/assay/aid/${aid}/cids/JSON`, {
                    params: { MaxRecords: 20 }
                  });

                  if (activeResponse.data?.IdentifierList?.CID) {
                    const cids = activeResponse.data.IdentifierList.CID.slice(0, 5);
                    
                    // Get compound details
                    try {
                      const compoundResponse = await this.apiClient.get(`/compound/cid/${cids.join(',')}/property/MolecularWeight,CanonicalSMILES,IUPACName/JSON`);
                      
                      if (compoundResponse.data?.PropertyTable?.Properties) {
                        for (const prop of compoundResponse.data.PropertyTable.Properties) {
                          targetResults.compounds.push({
                            cid: prop.CID,
                            name: prop.IUPACName,
                            smiles: prop.CanonicalSMILES,
                            molecular_weight: prop.MolecularWeight,
                            assay_aid: aid,
                            assay_name: assayInfo.Name
                          });
                        }
                      }
                    } catch (error) {
                      // Skip compound details if not available
                    }
                  }
                } catch (error) {
                  // Skip active compounds if not available
                }
              }
            } catch (error) {
              // Skip individual assay processing
            }
          }
        }
      } catch (error) {
        // Target search failed, try alternative approaches
        targetResults.note = `Direct target search failed. Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }

      // If no results from direct target search, try text search
      if (targetResults.compounds.length === 0 && targetResults.assays.length === 0) {
        try {
          const textResponse = await this.apiClient.get(`/assay/name/${encodeURIComponent(target)}/aids/JSON`, {
            params: { MaxRecords: 10 }
          });

          if (textResponse.data?.IdentifierList?.AID) {
            const aids = textResponse.data.IdentifierList.AID.slice(0, 5);
            
            for (const aid of aids) {
              try {
                const assayDetail = await this.apiClient.get(`/assay/aid/${aid}/summary/JSON`);
                if (assayDetail.data?.AssaySummaries?.[0]) {
                  targetResults.assays.push({
                    aid: aid,
                    search_method: 'text_search',
                    details: assayDetail.data.AssaySummaries[0]
                  });
                }
              } catch (error) {
                // Skip individual assay errors
              }
            }
          }
        } catch (error) {
          targetResults.note = targetResults.note ? 
            targetResults.note + '. Text search also failed.' : 
            'Text search failed';
        }
      }

      targetResults.summary.total_compounds = targetResults.compounds.length;
      targetResults.summary.total_assays = targetResults.assays.length;

      // Add recommendations if no results found
      if (targetResults.compounds.length === 0 && targetResults.assays.length === 0) {
        targetResults.recommendations = [
          'Try alternative target names or synonyms',
          'Check ChEMBL database for more comprehensive target-compound data',
          'Search for related protein family members',
          'Use UniProt to find official gene/protein names',
          'Consider searching by pathway or biological process'
        ];
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(targetResults, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching by target: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleCompareActivityProfiles(args: any) {
    if (!Array.isArray(args.cids) || args.cids.length < 2 || args.cids.length > 50) {
      throw new McpError(ErrorCode.InvalidParams, 'CIDs array must contain 2-50 compound IDs');
    }

    try {
      const cids = args.cids;
      const activityType = args.activity_type || '';
      
      const comparisonData: any = {
        compound_ids: cids,
        activity_type_filter: activityType,
        compounds: [],
        shared_assays: [],
        activity_comparison: {
          common_targets: [],
          unique_activities: {},
          similarity_matrix: []
        },
        summary: {
          total_compounds: cids.length,
          compounds_with_data: 0,
          shared_assays_count: 0,
          common_targets_count: 0
        },
        last_updated: new Date().toISOString()
      };

      // Get basic compound information
      try {
        const compoundResponse = await this.apiClient.get(`/compound/cid/${cids.join(',')}/property/MolecularWeight,CanonicalSMILES,IUPACName,XLogP,TPSA/JSON`);
        
        if (compoundResponse.data?.PropertyTable?.Properties) {
          comparisonData.compounds = compoundResponse.data.PropertyTable.Properties.map((prop: any) => ({
            cid: prop.CID,
            name: prop.IUPACName || `Compound ${prop.CID}`,
            smiles: prop.CanonicalSMILES,
            molecular_weight: prop.MolecularWeight,
            logp: prop.XLogP,
            tpsa: prop.TPSA,
            bioactivities: []
          }));
        }
      } catch (error) {
        // Continue without basic compound data
      }

      // Get bioactivity data for each compound
      const compoundActivities: any = {};
      
      for (const cid of cids.slice(0, 10)) { // Limit to prevent API overload
        try {
          const assayResponse = await this.apiClient.get(`/compound/cid/${cid}/assaysummary/JSON`);
          
          if (assayResponse.data?.Table?.Row) {
            const assayRows = Array.isArray(assayResponse.data.Table.Row) 
              ? assayResponse.data.Table.Row 
              : [assayResponse.data.Table.Row];

            compoundActivities[cid] = [];
            
            for (const row of assayRows.slice(0, 20)) { // Limit per compound
              try {
                const cells = row.Cell;
                const aid = cells[0];
                const outcome = cells[1] || 'Unknown';
                const potency = cells[2] || null;
                
                // Filter by activity type if specified
                if (activityType && potency && !String(potency).toLowerCase().includes(activityType.toLowerCase())) {
                  continue;
                }

                compoundActivities[cid].push({
                  aid: aid,
                  outcome: outcome,
                  potency: potency,
                  activity_type: activityType || 'general'
                });
              } catch (error) {
                // Skip individual row errors
              }
            }

            if (compoundActivities[cid].length > 0) {
              comparisonData.summary.compounds_with_data++;
            }
          }
        } catch (error) {
          compoundActivities[cid] = [];
        }
      }

      // Find shared assays across compounds
      const assayMap: any = {};
      for (const [cid, activities] of Object.entries(compoundActivities)) {
        for (const activity of activities as any[]) {
          if (!assayMap[activity.aid]) {
            assayMap[activity.aid] = [];
          }
          assayMap[activity.aid].push({
            cid: cid,
            outcome: activity.outcome,
            potency: activity.potency
          });
        }
      }

      // Identify assays with multiple compounds
      for (const [aid, compounds] of Object.entries(assayMap)) {
        if ((compounds as any[]).length >= 2) {
          comparisonData.shared_assays.push({
            aid: aid,
            compound_count: (compounds as any[]).length,
            results: compounds
          });
        }
      }

      comparisonData.summary.shared_assays_count = comparisonData.shared_assays.length;

      // Calculate activity similarity between compounds
      const similarities: any = {};
      for (let i = 0; i < cids.length; i++) {
        for (let j = i + 1; j < cids.length; j++) {
          const cid1 = cids[i];
          const cid2 = cids[j];
          
          const activities1 = compoundActivities[cid1] || [];
          const activities2 = compoundActivities[cid2] || [];
          
          const aids1 = new Set(activities1.map((a: any) => a.aid));
          const aids2 = new Set(activities2.map((a: any) => a.aid));
          
          const intersection = new Set([...aids1].filter(x => aids2.has(x)));
          const union = new Set([...aids1, ...aids2]);
          
          const similarity = union.size > 0 ? intersection.size / union.size : 0;
          
          similarities[`${cid1}_${cid2}`] = {
            cid1: cid1,
            cid2: cid2,
            jaccard_similarity: similarity,
            shared_assays: intersection.size,
            total_unique_assays: union.size
          };
        }
      }

      comparisonData.activity_comparison.similarity_matrix = Object.values(similarities);

      // Add compound bioactivities to the compound objects
      for (const compound of comparisonData.compounds) {
        compound.bioactivities = compoundActivities[compound.cid] || [];
        compound.total_assays = compound.bioactivities.length;
        compound.active_assays = compound.bioactivities.filter((a: any) => 
          String(a.outcome).toLowerCase().includes('active')).length;
      }

      // Generate insights
      comparisonData.insights = {
        most_similar_pair: comparisonData.activity_comparison.similarity_matrix.length > 0 ? 
          comparisonData.activity_comparison.similarity_matrix.reduce((max: any, current: any) => 
            current.jaccard_similarity > max.jaccard_similarity ? current : max) : null,
        most_active_compound: comparisonData.compounds.length > 0 ? 
          comparisonData.compounds.reduce((max: any, current: any) => 
            current.active_assays > max.active_assays ? current : max) : null,
        recommendations: [
          'Use ChEMBL for more comprehensive bioactivity comparisons',
          'Consider structural similarity alongside activity similarity',
          'Analyze specific activity types (IC50, Ki, etc.) for better insights',
          'Look for selectivity patterns across target families'
        ]
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(comparisonData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error comparing activity profiles: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleGetSafetyData(args: any) {
    if (!isValidCidArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid CID arguments');
    }

    try {
      const response = await this.apiClient.get(`/compound/cid/${args.cid}/classification/JSON`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get safety data: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async handleGetToxicityInfo(args: any) {
    if (!isValidCidArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid CID arguments');
    }

    try {
      const cid = args.cid;
      const toxicityData: any = {
        cid: cid,
        toxicity_summary: {
          acute_toxicity: {},
          chronic_toxicity: {},
          carcinogenicity: {},
          mutagenicity: {},
          reproductive_toxicity: {},
          environmental_toxicity: {}
        },
        data_sources: [],
        last_updated: new Date().toISOString()
      };

      // Try to get GHS classification data which includes toxicity information
      try {
        const ghsResponse = await this.apiClient.get(`/compound/cid/${cid}/classification/JSON`);
        if (ghsResponse.data?.Informations) {
          const ghsInfo = ghsResponse.data.Informations[0];
          if (ghsInfo?.GHSClassification) {
            toxicityData.ghs_classification = ghsInfo.GHSClassification;
            toxicityData.data_sources.push('GHS Classification');
          }
        }
      } catch (error) {
        // GHS data not available, continue with other sources
      }

      // Try to get compound description which may contain toxicity information
      try {
        const descResponse = await this.apiClient.get(`/compound/cid/${cid}/description/JSON`);
        if (descResponse.data?.InformationList?.Information) {
          const descriptions = descResponse.data.InformationList.Information;
          const toxicityDescriptions = descriptions.filter((desc: any) => 
            desc.Title && (
              desc.Title.toLowerCase().includes('toxicity') ||
              desc.Title.toLowerCase().includes('toxic') ||
              desc.Title.toLowerCase().includes('ld50') ||
              desc.Title.toLowerCase().includes('carcinogen') ||
              desc.Title.toLowerCase().includes('mutagen')
            )
          );
          
          if (toxicityDescriptions.length > 0) {
            toxicityData.toxicity_descriptions = toxicityDescriptions.map((desc: any) => ({
              title: desc.Title,
              description: desc.Description,
              source: desc.SourceName,
              url: desc.ReferenceNumber ? `https://pubchem.ncbi.nlm.nih.gov/source/${desc.ReferenceNumber}` : null
            }));
            toxicityData.data_sources.push('PubChem Descriptions');
          }
        }
      } catch (error) {
        // Description data not available
      }

      // Get basic compound properties that relate to toxicity
      try {
        const propResponse = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularWeight,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount/JSON`);
        if (propResponse.data?.PropertyTable?.Properties?.[0]) {
          const props = propResponse.data.PropertyTable.Properties[0];
          toxicityData.molecular_properties = {
            molecular_weight: props.MolecularWeight,
            logp: props.XLogP,
            polar_surface_area: props.TPSA,
            hbd_count: props.HBondDonorCount,
            hba_count: props.HBondAcceptorCount
          };
          
          // Basic toxicity predictions based on molecular properties
          toxicityData.predicted_toxicity = {
            oral_toxicity_class: this.predictOralToxicity(props.MolecularWeight, props.XLogP),
            bioaccumulation_potential: props.XLogP > 3 ? 'High' : props.XLogP > 1 ? 'Moderate' : 'Low',
            membrane_permeability: props.TPSA < 140 ? 'High' : 'Low'
          };
        }
      } catch (error) {
        // Properties not available
      }

      // Add general toxicity assessment notes
      toxicityData.assessment_notes = [
        'This is a computational assessment based on available PubChem data',
        'For definitive toxicity information, consult official regulatory databases',
        'Experimental validation is required for safety assessments',
        'Data availability varies significantly between compounds'
      ];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(toxicityData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching toxicity info: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleAssessEnvironmentalFate(args: any) {
    if (!isValidCidArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid CID arguments');
    }

    try {
      const cid = args.cid;
      const environmentalData: any = {
        cid: cid,
        environmental_fate: {
          biodegradation: {},
          bioaccumulation: {},
          atmospheric_fate: {},
          aquatic_fate: {},
          soil_fate: {}
        },
        regulatory_status: {},
        data_sources: [],
        last_updated: new Date().toISOString()
      };

      // Get molecular properties for environmental fate prediction
      try {
        const propResponse = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularWeight,XLogP,TPSA,CanonicalSMILES,MolecularFormula/JSON`);
        if (propResponse.data?.PropertyTable?.Properties?.[0]) {
          const props = propResponse.data.PropertyTable.Properties[0];
          environmentalData.molecular_properties = {
            molecular_weight: props.MolecularWeight,
            logp: props.XLogP,
            polar_surface_area: props.TPSA,
            smiles: props.CanonicalSMILES,
            formula: props.MolecularFormula
          };

          // Predict environmental fate based on molecular properties
          environmentalData.environmental_fate = {
            biodegradation: {
              predicted_rate: this.predictBiodegradation(props.MolecularWeight, props.XLogP),
              factors: [
                'Molecular weight affects microbial uptake',
                'LogP influences bioavailability',
                'Structural complexity affects degradation pathways'
              ]
            },
            bioaccumulation: {
              potential: props.XLogP > 3 ? 'High' : props.XLogP > 1 ? 'Moderate' : 'Low',
              bcf_estimate: props.XLogP ? Math.pow(10, 0.85 * props.XLogP - 0.70) : 'Not calculated',
              factors: ['LogP is primary indicator of bioaccumulation potential']
            },
            atmospheric_fate: {
              volatility: props.MolecularWeight < 200 ? 'High' : props.MolecularWeight < 500 ? 'Moderate' : 'Low',
              photodegradation: 'Depends on molecular structure and UV absorption',
              factors: ['Molecular weight affects vapor pressure']
            },
            aquatic_fate: {
              solubility_prediction: props.XLogP < 0 ? 'High' : props.XLogP < 3 ? 'Moderate' : 'Low',
              sorption_potential: props.XLogP > 2.5 ? 'High' : 'Low',
              factors: ['LogP correlates with water solubility and sorption']
            },
            soil_fate: {
              mobility: props.XLogP < 2 ? 'High' : props.XLogP < 4 ? 'Moderate' : 'Low',
              persistence: 'Depends on soil conditions and microbial activity',
              factors: ['Sorption to organic matter increases with LogP']
            }
          };

          environmentalData.data_sources.push('Molecular Property Predictions');
        }
      } catch (error) {
        // Properties not available
      }

      // Try to get environmental classification data
      try {
        const classResponse = await this.apiClient.get(`/compound/cid/${cid}/classification/JSON`);
        if (classResponse.data?.Informations) {
          const classInfo = classResponse.data.Informations[0];
          if (classInfo?.GHSClassification) {
            // Look for environmental hazard classifications
            const envHazards = classInfo.GHSClassification.filter((item: any) => 
              item.Category && (
                item.Category.toLowerCase().includes('aquatic') ||
                item.Category.toLowerCase().includes('environmental') ||
                item.Category.toLowerCase().includes('ozone')
              )
            );
            
            if (envHazards.length > 0) {
              environmentalData.environmental_hazards = envHazards;
              environmentalData.data_sources.push('GHS Environmental Classification');
            }
          }
        }
      } catch (error) {
        // Classification data not available
      }

      // Add assessment methodology and limitations
      environmentalData.assessment_methodology = {
        approach: 'QSAR-based predictions using molecular descriptors',
        limitations: [
          'Predictions are estimates based on molecular properties',
          'Actual environmental fate depends on specific conditions',
          'Experimental data should be used when available',
          'Metabolites and transformation products not considered'
        ],
        recommended_tests: [
          'OECD biodegradation studies',
          'Bioaccumulation factor determination',
          'Environmental monitoring data',
          'Ecotoxicity testing'
        ]
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(environmentalData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error assessing environmental fate: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleGetRegulatoryInfo(args: any) {
    if (!isValidCidArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid CID arguments');
    }

    try {
      const cid = args.cid;
      const regulatoryData: any = {
        cid: cid,
        regulatory_status: {
          fda: {},
          epa: {},
          echa: {},
          international: {}
        },
        classifications: {},
        data_sources: [],
        last_updated: new Date().toISOString()
      };

      // Get basic compound information
      try {
        const compoundResponse = await this.apiClient.get(`/compound/cid/${cid}/JSON`);
        if (compoundResponse.data?.PC_Compounds?.[0]) {
          const compound = compoundResponse.data.PC_Compounds[0];
          regulatoryData.compound_info = {
            iupac_name: compound.props?.find((p: any) => p.urn?.label === 'IUPAC Name')?.value?.sval,
            molecular_formula: compound.props?.find((p: any) => p.urn?.label === 'Molecular Formula')?.value?.sval,
            cas_number: compound.props?.find((p: any) => p.urn?.label === 'CAS')?.value?.sval
          };
        }
      } catch (error) {
        // Compound info not available
      }

      // Get GHS classification which includes regulatory classifications
      try {
        const ghsResponse = await this.apiClient.get(`/compound/cid/${cid}/classification/JSON`);
        if (ghsResponse.data?.Informations) {
          const ghsInfo = ghsResponse.data.Informations[0];
          if (ghsInfo?.GHSClassification) {
            regulatoryData.classifications.ghs = {
              hazard_classes: ghsInfo.GHSClassification.map((item: any) => ({
                category: item.Category,
                classification: item.Classification,
                hazard_statement: item.HazardStatement,
                signal_word: item.SignalWord
              })),
              source: ghsInfo.SourceName,
              reference: ghsInfo.ReferenceNumber
            };
            regulatoryData.data_sources.push('GHS Classification System');
          }
        }
      } catch (error) {
        // GHS data not available
      }

      // Try to get compound descriptions that may contain regulatory information
      try {
        const descResponse = await this.apiClient.get(`/compound/cid/${cid}/description/JSON`);
        if (descResponse.data?.InformationList?.Information) {
          const descriptions = descResponse.data.InformationList.Information;
          const regulatoryDescriptions = descriptions.filter((desc: any) => 
            desc.Title && (
              desc.Title.toLowerCase().includes('regulation') ||
              desc.Title.toLowerCase().includes('regulatory') ||
              desc.Title.toLowerCase().includes('fda') ||
              desc.Title.toLowerCase().includes('epa') ||
              desc.Title.toLowerCase().includes('approval') ||
              desc.Title.toLowerCase().includes('controlled') ||
              desc.Title.toLowerCase().includes('schedule')
            )
          );
          
          if (regulatoryDescriptions.length > 0) {
            regulatoryData.regulatory_descriptions = regulatoryDescriptions.map((desc: any) => ({
              title: desc.Title,
              description: desc.Description,
              source: desc.SourceName,
              url: desc.ReferenceNumber ? `https://pubchem.ncbi.nlm.nih.gov/source/${desc.ReferenceNumber}` : null
            }));
            regulatoryData.data_sources.push('PubChem Regulatory Descriptions');
          }
        }
      } catch (error) {
        // Description data not available
      }

      // Add regulatory framework information
      regulatoryData.regulatory_frameworks = {
        united_states: {
          fda: {
            description: 'Food and Drug Administration',
            scope: 'Food additives, drugs, cosmetics, medical devices',
            database_url: 'https://www.fda.gov/'
          },
          epa: {
            description: 'Environmental Protection Agency',
            scope: 'Pesticides, industrial chemicals, environmental contaminants',
            database_url: 'https://www.epa.gov/'
          },
          osha: {
            description: 'Occupational Safety and Health Administration',
            scope: 'Workplace chemical safety',
            database_url: 'https://www.osha.gov/'
          }
        },
        european_union: {
          echa: {
            description: 'European Chemicals Agency',
            scope: 'REACH regulation, CLP classification',
            database_url: 'https://echa.europa.eu/'
          },
          ema: {
            description: 'European Medicines Agency',
            scope: 'Pharmaceutical regulation',
            database_url: 'https://www.ema.europa.eu/'
          }
        },
        international: {
          who: {
            description: 'World Health Organization',
            scope: 'Global health standards',
            database_url: 'https://www.who.int/'
          },
          oecd: {
            description: 'Organisation for Economic Co-operation and Development',
            scope: 'Chemical testing guidelines',
            database_url: 'https://www.oecd.org/'
          }
        }
      };

      // Add data limitations and recommendations
      regulatoryData.data_limitations = [
        'PubChem aggregates data from multiple sources with varying update frequencies',
        'Regulatory status can change frequently - verify with official sources',
        'Some regulatory information may not be publicly available',
        'Regional regulations may differ significantly'
      ];

      regulatoryData.recommendations = [
        'Consult official regulatory databases for current status',
        'Check multiple jurisdictions for comprehensive coverage',
        'Consider consulting regulatory affairs professionals',
        'Monitor regulatory updates for changes in status'
      ];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(regulatoryData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching regulatory info: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Helper methods for toxicity and environmental predictions
  private predictOralToxicity(molecularWeight?: number, logP?: number): string {
    if (!molecularWeight || !logP) return 'Cannot predict - insufficient data';
    
    // Simple QSAR-based prediction
    if (molecularWeight > 500 && logP > 5) return 'Class IV (Low toxicity)';
    if (molecularWeight < 200 && logP < 0) return 'Class II (Moderate toxicity)';
    if (logP > 3 && molecularWeight < 300) return 'Class III (Moderate-low toxicity)';
    return 'Class III-IV (Moderate-low toxicity)';
  }

  private predictBiodegradation(molecularWeight?: number, logP?: number): string {
    if (!molecularWeight || !logP) return 'Cannot predict - insufficient data';
    
    if (molecularWeight < 200 && logP < 3) return 'Fast (days to weeks)';
    if (molecularWeight < 500 && logP < 4) return 'Moderate (weeks to months)';
    if (molecularWeight > 500 || logP > 5) return 'Slow (months to years)';
    return 'Moderate (weeks to months)';
  }

  private async handleGetExternalReferences(args: any) {
    try {
      const cid = args.cid;
      
      if (!cid) {
        throw new McpError(ErrorCode.InvalidParams, 'CID is required');
      }

      const referencesData: any = {
        compound_id: cid,
        external_references: {
          chemical_databases: [],
          biological_databases: [],
          patent_databases: [],
          literature_databases: [],
          vendor_databases: []
        },
        cross_references: {
          total_count: 0,
          by_database_type: {}
        },
        identifiers: {
          primary: {},
          alternative: []
        },
        last_updated: new Date().toISOString()
      };

      // Get basic compound identifiers first
      try {
        const identifierResponse = await this.apiClient.get(`/compound/cid/${cid}/property/InChI,InChIKey,CanonicalSMILES,IUPACName,MolecularFormula/JSON`);
        
        if (identifierResponse.data?.PropertyTable?.Properties?.[0]) {
          const props = identifierResponse.data.PropertyTable.Properties[0];
          referencesData.identifiers.primary = {
            cid: props.CID,
            inchi: props.InChI,
            inchi_key: props.InChIKey,
            smiles: props.CanonicalSMILES,
            iupac_name: props.IUPACName,
            molecular_formula: props.MolecularFormula
          };
        }
      } catch (error) {
        // Continue without basic identifiers
      }

      // Get synonyms which often contain external database IDs
      try {
        const synonymResponse = await this.apiClient.get(`/compound/cid/${cid}/synonyms/JSON`);
        
        if (synonymResponse.data?.InformationList?.Information?.[0]?.Synonym) {
          const synonyms = synonymResponse.data.InformationList.Information[0].Synonym;
          
          // Parse synonyms to identify external database references
          const externalRefs = this.parseExternalReferences(synonyms);
          referencesData.external_references = externalRefs;
          
          // Count references by type
          let totalCount = 0;
          for (const [dbType, refs] of Object.entries(externalRefs)) {
            const count = Array.isArray(refs) ? refs.length : 0;
            referencesData.cross_references.by_database_type[dbType] = count;
            totalCount += count;
          }
          referencesData.cross_references.total_count = totalCount;
        }
      } catch (error) {
        // Continue without synonyms
      }

      // Get additional cross-references from PubChem's xrefs endpoint
      try {
        const xrefResponse = await this.apiClient.get(`/compound/cid/${cid}/xrefs/RegistryID,RN,PubMedID,MMDBID,ProteinGI,NucleotideGI,TaxonomyID,MIMID,GeneID,ProbeID,PatentID/JSON`);
        
        if (xrefResponse.data?.InformationList?.Information?.[0]?.XRef) {
          const xrefs = xrefResponse.data.InformationList.Information[0].XRef;
          this.processXrefs(xrefs, referencesData);
        }
      } catch (error) {
        // Continue without xrefs - this endpoint might not always be available
      }

      // Add PubChem-specific references
      referencesData.external_references.chemical_databases.push({
        database: 'PubChem',
        identifier: cid,
        url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
        type: 'primary'
      });

      // Generate recommendations for finding more references
      referencesData.recommendations = [
        'Use ChEMBL for bioactivity cross-references',
        'Check UniProt for protein target information',
        'Search PDB for structural data',
        'Consult DrugBank for drug information',
        'Use ChEBI for chemical ontology terms'
      ];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(referencesData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting external references: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Helper method to parse external references from synonyms
  private parseExternalReferences(synonyms: string[]): any {
    const refs: any = {
      chemical_databases: [],
      biological_databases: [],
      patent_databases: [],
      literature_databases: [],
      vendor_databases: []
    };

    for (const synonym of synonyms) {
      // ChEBI references
      if (synonym.match(/^CHEBI:\d+$/)) {
        refs.chemical_databases.push({
          database: 'ChEBI',
          identifier: synonym,
          url: `https://www.ebi.ac.uk/chebi/searchId.do?chebiId=${synonym}`,
          type: 'chemical_ontology'
        });
      }
      
      // CAS Registry Numbers
      else if (synonym.match(/^\d+-\d+-\d+$/)) {
        refs.chemical_databases.push({
          database: 'CAS',
          identifier: synonym,
          type: 'registry_number'
        });
      }
      
      // UNII codes
      else if (synonym.match(/^[A-Z0-9]{10}$/)) {
        refs.chemical_databases.push({
          database: 'FDA UNII',
          identifier: synonym,
          type: 'unique_ingredient_identifier'
        });
      }
      
      // Drugbank IDs
      else if (synonym.match(/^DB\d{5}$/)) {
        refs.biological_databases.push({
          database: 'DrugBank',
          identifier: synonym,
          url: `https://www.drugbank.ca/drugs/${synonym}`,
          type: 'drug_database'
        });
      }
      
      // KEGG Compound IDs
      else if (synonym.match(/^C\d{5}$/)) {
        refs.biological_databases.push({
          database: 'KEGG',
          identifier: synonym,
          url: `https://www.genome.jp/entry/compound+${synonym}`,
          type: 'pathway_database'
        });
      }
    }

    return refs;
  }

  // Helper method to process cross-references
  private processXrefs(xrefs: any, referencesData: any): void {
    for (const xref of xrefs) {
      if (xref.PubMedID) {
        referencesData.external_references.literature_databases.push({
          database: 'PubMed',
          identifier: xref.PubMedID,
          url: `https://pubmed.ncbi.nlm.nih.gov/${xref.PubMedID}/`,
          type: 'literature'
        });
      }
      
      if (xref.PatentID) {
        referencesData.external_references.patent_databases.push({
          database: 'Patent',
          identifier: xref.PatentID,
          type: 'patent'
        });
      }
    }
  }

  private async handleSearchPatents(args: any) {
    try {
      const cid = args.cid;
      const query = args.query;
      const maxRecords = Math.min(args.max_records || 50, 200);
      
      if (!cid && !query) {
        throw new McpError(ErrorCode.InvalidParams, 'Either CID or query is required for patent search');
      }

      const patentData: any = {
        search_parameters: {
          cid: cid,
          query: query,
          max_records: maxRecords,
          search_type: cid ? 'compound_patents' : 'text_search'
        },
        patents: [],
        summary: {
          total_found: 0,
          unique_assignees: [],
          date_range: {},
          patent_types: {}
        },
        last_updated: new Date().toISOString()
      };

      if (cid) {
        // Search patents for a specific compound
        try {
          // Get patent information from PubChem cross-references
          const xrefResponse = await this.apiClient.get(`/compound/cid/${cid}/xrefs/PatentID/JSON`);
          
          if (xrefResponse.data?.InformationList?.Information?.[0]?.PatentID) {
            const patentIds = Array.isArray(xrefResponse.data.InformationList.Information[0].PatentID) 
              ? xrefResponse.data.InformationList.Information[0].PatentID 
              : [xrefResponse.data.InformationList.Information[0].PatentID];

            patentData.summary.total_found = patentIds.length;
            
            // Process patent IDs and create patent entries
            patentData.patents = patentIds.slice(0, maxRecords).map((patentId: string, index: number) => ({
              patent_id: patentId,
              title: `Patent ${patentId}`,
              compound_cid: cid,
              url: this.generatePatentUrl(patentId),
              status: 'unknown',
              relevance_score: 1.0 - (index * 0.01), // Simple relevance scoring
              found_via: 'pubchem_xref'
            }));
          }
        } catch (error) {
          // Continue with empty results if patent xref fails
        }

        // Also try to get patent info from compound synonyms
        try {
          const synonymResponse = await this.apiClient.get(`/compound/cid/${cid}/synonyms/JSON`);
          
          if (synonymResponse.data?.InformationList?.Information?.[0]?.Synonym) {
            const synonyms = synonymResponse.data.InformationList.Information[0].Synonym;
            const patentReferences = this.extractPatentReferences(synonyms);
            
            // Add unique patent references from synonyms
            for (const patentRef of patentReferences) {
              if (!patentData.patents.find((p: any) => p.patent_id === patentRef.id)) {
                patentData.patents.push({
                  patent_id: patentRef.id,
                  title: patentRef.title || `Patent ${patentRef.id}`,
                  compound_cid: cid,
                  url: patentRef.url,
                  status: 'unknown',
                  relevance_score: 0.8,
                  found_via: 'synonym_extraction'
                });
              }
            }
          }
        } catch (error) {
          // Continue without synonym-based patents
        }
      } else if (query) {
        // Text-based patent search (limited functionality)
        patentData.patents = [{
          patent_id: 'SEARCH_REQUIRED',
          title: `Patent search for: "${query}"`,
          note: 'PubChem does not provide text-based patent search. Use specialized patent databases.',
          recommendations: [
            'Use Google Patents (patents.google.com)',
            'Search USPTO database (uspto.gov)',
            'Try European Patent Office (epo.org)',
            'Consider commercial patent databases like PatentScope'
          ],
          found_via: 'search_guidance'
        }];
      }

      // Update summary statistics
      patentData.summary.total_found = patentData.patents.length;
      
      // Extract unique assignees and other metadata
      const assignees = new Set();
      const years = [];
      const types = new Set();
      
      for (const patent of patentData.patents) {
        if (patent.assignee) assignees.add(patent.assignee);
        if (patent.year) years.push(patent.year);
        if (patent.type) types.add(patent.type);
      }
      
      patentData.summary.unique_assignees = Array.from(assignees);
      patentData.summary.patent_types = Array.from(types);
      
      if (years.length > 0) {
        patentData.summary.date_range = {
          earliest: Math.min(...years),
          latest: Math.max(...years),
          span_years: Math.max(...years) - Math.min(...years)
        };
      }

      // Add recommendations
      patentData.recommendations = [
        'Use specialized patent databases for comprehensive searches',
        'Check patent family information for related filings',
        'Analyze patent claims for specific compound coverage',
        'Consider freedom-to-operate analysis',
        'Review patent prosecution history for insights'
      ];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(patentData, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching patents: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  // Helper method to generate patent URLs
  private generatePatentUrl(patentId: string): string {
    // Try to determine patent office and format URL
    if (patentId.match(/^US\d+/)) {
      return `https://patents.google.com/patent/${patentId}`;
    } else if (patentId.match(/^EP\d+/)) {
      return `https://patents.google.com/patent/${patentId}`;
    } else if (patentId.match(/^WO\d+/)) {
      return `https://patents.google.com/patent/${patentId}`;
    } else {
      return `https://patents.google.com/patent/${patentId}`;
    }
  }

  // Helper method to extract patent references from synonyms
  private extractPatentReferences(synonyms: string[]): any[] {
    const patents = [];
    
    for (const synonym of synonyms) {
      // Look for patent-like patterns
      const patentPatterns = [
        /^US\d{7,8}[A-Z]?\d?$/,  // US patents
        /^EP\d{7}[A-Z]\d?$/,     // European patents  
        /^WO\d{4}\/\d{6}$/,      // WIPO patents
        /^JP\d{7,8}[A-Z]?$/      // Japanese patents
      ];
      
      for (const pattern of patentPatterns) {
        if (pattern.test(synonym)) {
          patents.push({
            id: synonym,
            title: `Patent ${synonym}`,
            url: this.generatePatentUrl(synonym)
          });
          break;
        }
      }
    }
    
    return patents;
  }

  private async handleGetLiteratureReferences(args: any) {
    return { content: [{ type: 'text', text: JSON.stringify({ message: 'Literature references not yet implemented', args }, null, 2) }] };
  }

  private async handleBatchCompoundLookup(args: any) {
    if (!isValidBatchArgs(args)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid batch arguments');
    }

    try {
      const results = [];
      for (const cid of args.cids.slice(0, 10)) {
        try {
          const response = await this.apiClient.get(`/compound/cid/${cid}/property/MolecularWeight,CanonicalSMILES,IUPACName/JSON`);
          results.push({ cid, data: response.data, success: true });
        } catch (error) {
          results.push({ cid, error: error instanceof Error ? error.message : 'Unknown error', success: false });
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ batch_results: results }, null, 2) }] };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Batch lookup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('PubChem MCP server running on stdio');
  }
}

const server = new PubChemServer();
server.run().catch(console.error);
