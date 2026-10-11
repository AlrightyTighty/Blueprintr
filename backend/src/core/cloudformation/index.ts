import type { TfModel } from '../terraform/model.js';
import type { SourceFile } from '../terraform/model.js';
import { addCloudFormation } from './convert.js';
import { parseCfnTemplate, type CfnTemplate } from './template.js';

const TEMPLATE_EXTENSION = /\.(ya?ml|json)$/i;

/**
 * Finds CloudFormation templates among the files (hand-written, or `cdk synth` output such as
 * `cdk.out/*.template.json`) and adds their resources to the model. Blueprint never runs `cdk synth`
 * or any CDK code, so a CDK app is analysable only when its synthesized templates are in the repository.
 */
export function addCloudFormationTemplates(model: TfModel, files: SourceFile[]): { templates: number; resources: number } {
  const templates: CfnTemplate[] = [];
  for (const file of files) {
    if (!TEMPLATE_EXTENSION.test(file.path)) continue;
    const result = parseCfnTemplate(file.path, file.content);
    if (!result) continue;
    if (result.kind === 'error') model.errors.push({ file: file.path, message: result.message });
    else templates.push(result.template);
  }
  return { templates: templates.length, resources: addCloudFormation(model, templates) };
}
