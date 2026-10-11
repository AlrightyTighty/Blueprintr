import { z } from 'zod';
import { uuid } from '../../http/validation.js';

const branchAndFolder = {
  branch: z.string().min(1).max(250).optional(),
  rootPath: z.string().max(500).optional(),
};

/** Either a repository picked from a connected GitHub account, or any GitHub link. */
export const linkRepositorySchema = z.union([
  z.object({ connectionId: uuid, githubRepoId: z.number().int().positive(), ...branchAndFolder }),
  z.object({ url: z.string().trim().min(1).max(500), ...branchAndFolder }),
]);
