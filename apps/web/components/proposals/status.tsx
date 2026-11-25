import { PROPOSAL_STATUS_LABEL, type ProposalDTO } from '@minions/core/contracts';
import { Badge } from '../ui';

const TONE: Record<ProposalDTO['status'], 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  in_review: 'warning',
  submitted: 'accent',
  won: 'success',
  lost: 'danger',
  cancelled: 'neutral',
};

export function ProposalStatusBadge({ status }: { status: ProposalDTO['status'] }) {
  return (
    <Badge tone={TONE[status]} dot>
      {PROPOSAL_STATUS_LABEL[status]}
    </Badge>
  );
}
