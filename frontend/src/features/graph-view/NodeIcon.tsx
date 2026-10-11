import { getNodeCategory } from '../../core/graph/nodeDisplay';
import type { GraphNode } from '../../core/graph/types';
// Service icons (the coloured squares) and resource icons (plain glyphs; the "Dark" variant has the
// bright colours meant for dark backgrounds) from the aws-svg-icons package. Vite turns each import
// into an image URL. The folders aren't named consistently ("64" vs "Arch_64"), so each path is explicit.
import apiGatewayIcon from 'aws-svg-icons/lib/Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_Amazon-API-Gateway_64.svg';
import sqsIcon from 'aws-svg-icons/lib/Architecture-Service-Icons_07302021/Arch_App-Integration/Arch_64/Arch_Amazon-Simple-Queue-Service_64.svg';
import lambdaIcon from 'aws-svg-icons/lib/Architecture-Service-Icons_07302021/Arch_Compute/64/Arch_AWS-Lambda_64.svg';
import dynamoDbIcon from 'aws-svg-icons/lib/Architecture-Service-Icons_07302021/Arch_Database/64/Arch_Amazon-DynamoDB_64.svg';
import cloudFrontIcon from 'aws-svg-icons/lib/Architecture-Service-Icons_07302021/Arch_Networking-Content-Delivery/64/Arch_Amazon-CloudFront_64.svg';
import route53Icon from 'aws-svg-icons/lib/Architecture-Service-Icons_07302021/Arch_Networking-Content-Delivery/64/Arch_Amazon-Route-53_64.svg';
import s3Icon from 'aws-svg-icons/lib/Architecture-Service-Icons_07302021/Arch_Storage/64/Arch_Amazon-Simple-Storage-Service_64.svg';
import iamPermissionsIcon from 'aws-svg-icons/lib/Resource-Icons_07302021/Res_Security-Identity-and-Compliance/Res_48_Dark/Res_AWS-Identity-Access-Management_Permissions_48_Dark.svg';
import iamRoleIcon from 'aws-svg-icons/lib/Resource-Icons_07302021/Res_Security-Identity-and-Compliance/Res_48_Dark/Res_AWS-Identity-Access-Management_Role_48_Dark.svg';

// The catalog (database/003_resource_types.sql) names each resource type's icon with a key such as
// "aws/lambda". These are the pictures behind those keys. To support a new key, add its icon here.
export const ICON_URL_BY_KEY: Record<string, string> = {
  'aws/lambda': lambdaIcon,
  'aws/s3': s3Icon,
  'aws/dynamodb': dynamoDbIcon,
  'aws/sqs': sqsIcon,
  'aws/iam-role': iamRoleIcon,
  'aws/iam-policy': iamPermissionsIcon,
  'aws/api-gateway': apiGatewayIcon,
  'aws/cloudfront': cloudFrontIcon,
  'aws/route53': route53Icon,
};

/** A hardcoded resource, e.g. "unmanaged:s3:legacy-reports", shows its service's icon. */
const ICON_KEY_BY_UNMANAGED_SERVICE: Record<string, string> = {
  s3: 'aws/s3',
  dynamodb: 'aws/dynamodb',
  sqs: 'aws/sqs',
};

interface DrawnIconProps {
  size: number;
  className?: string;
}

// Simple line icons for things AWS has no logo for.
function drawn(paths: string) {
  return function DrawnIcon({ size, className }: DrawnIconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: paths }}
      />
    );
  };
}

const CodeIcon = drawn('<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>');
const UnknownIcon = drawn(
  '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
);
const GenericIcon = drawn('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5"/>');

export function iconKeyFor(node: GraphNode): string | null {
  if (node.resourceType?.iconKey) return node.resourceType.iconKey;
  if (getNodeCategory(node) === 'unmanaged') {
    const service = node.address.split(':')[1];
    return ICON_KEY_BY_UNMANAGED_SERVICE[service] ?? null;
  }
  return null;
}

interface NodeIconProps {
  node: GraphNode;
  size?: number;
  className?: string;
}

/** The picture for a node: its AWS icon when we have one, otherwise a plain symbol that says what kind of thing it is. */
export default function NodeIcon({ node, size = 48, className }: NodeIconProps) {
  const key = iconKeyFor(node);
  const url = key ? ICON_URL_BY_KEY[key] : undefined;
  // alt is empty because the node's name is always shown next to its icon.
  if (url) return <img src={url} width={size} height={size} alt="" draggable={false} className={className} />;

  const category = getNodeCategory(node);
  const Fallback = category === 'code' ? CodeIcon : category === 'unresolved' ? UnknownIcon : GenericIcon;
  return <Fallback size={size} className={`text-indigo-300 ${className ?? ''}`} />;
}
