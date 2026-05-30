import type { WorkflowStep, StepStatus } from '../types';
import { STEP_LABELS, STEP_LETTERS, STEP_ORDER } from '../types';

interface StepProgressProps {
  steps: Record<WorkflowStep, { status: StepStatus }>;
  currentStep: WorkflowStep | null;
}

export function StepProgress({ steps, currentStep }: StepProgressProps) {
  return (
    <div className="step-progress">
      {STEP_ORDER.map((step, index) => {
        const stepState = steps[step];
        const status = stepState?.status || 'pending';
        const isActive = step === currentStep;
        const isCompleted = status === 'completed';
        const isFailed = status === 'failed';
        const isSkipped = status === 'skipped';

        return (
          <div
            key={step}
            className={`step-item ${status} ${isActive ? 'active' : ''}`}
          >
            <div className="step-indicator">
              <div className={`step-circle ${isCompleted ? 'completed' : ''} ${isFailed ? 'failed' : ''} ${isSkipped ? 'skipped' : ''} ${isActive ? 'pulse' : ''}`}>
                {isCompleted ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : isFailed ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                ) : (
                  <span className="step-icon-text">{STEP_LETTERS[step]}</span>
                )}
              </div>
              {index < STEP_ORDER.length - 1 && (
                <div className={`step-connector ${isCompleted ? 'completed' : ''}`} />
              )}
            </div>
            <div className="step-label">
              <span className="step-name">{STEP_LABELS[step]}</span>
              <span className={`step-badge ${status}`}>
                {status === 'pending' && 'Pending'}
                {status === 'running' && 'Running...'}
                {status === 'completed' && 'Done'}
                {status === 'failed' && 'Failed'}
                {status === 'skipped' && 'Skipped'}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
