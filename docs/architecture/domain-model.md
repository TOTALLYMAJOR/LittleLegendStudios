# Child Director Domain Model

## Core contracts

```ts
export type AgeGroup = 'toddler' | 'explorer' | 'director';

export interface ChildInterfaceConfig {
  ageGroup: AgeGroup;
  inputMethods: ('touch' | 'voice' | 'text')[];
  complexityLevel: 1 | 2 | 3;
  parentControls: boolean;
}

export interface ParentApprovalRequest {
  id: string;
  reason: 'complexity_too_high' | 'content_review' | 'runtime_limit' | 'policy_boundary';
  status: 'pending' | 'approved' | 'rejected';
}
```

## Placement guidance
- Shared contracts: `packages/shared/src`
- App and workflow services: `apps/web`, `apps/api`, `apps/worker`
- Keep UI components free of business-policy decisions.
