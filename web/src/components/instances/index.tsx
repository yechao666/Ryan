import { Card, CodeBlock, Dot, Icon } from '@ui';
import { instanceStatusMeta } from '../projects/helpers.tsx';

/**
 * 实例状态与注册指引：实例列表页、智员详情页共用。
 */

export function InstanceStatus({ status }: { status: string }) {
  const meta = instanceStatusMeta(status);
  return (
    <span className="cx-status">
      <Dot tone={meta.tone} pulse={meta.pulse} />
      <span>{meta.label}</span>
    </span>
  );
}

const REGISTER_SNIPPET = `# 1) 在「智员 → 访问令牌」创建 Agent 令牌（secret 只显示一次）
# 2) 用 Agent 令牌注册实例，响应中的 token 是实例令牌（secret 只返回一次）
curl -X POST http://127.0.0.1:4400/api/runtime/instances/register \\
  -H "authorization: Bearer hive_agt_xxxxxxxx" \\
  -H 'content-type: application/json' \\
  -d '{"name":"my-dsh-01","host":"dev-mac","workspacePath":"/workspace/orion","version":"dsh 0.2.1"}'

# 3) 实例令牌用于心跳、领取任务与上报进展
curl -X POST http://127.0.0.1:4400/api/runtime/instances/heartbeat \\
  -H "authorization: Bearer hive_inst_xxxxxxxx"`;

export function InstanceRegisterGuide({ compact }: { compact?: boolean }) {
  return (
    <Card className="card-pad cx-instance-guide">
      <div className="card-title">
        <Icon name="terminal" size={15} />
        如何注册实例
      </div>
      <p className="card-sub" style={{ marginBottom: 12 }}>
        实例是一台运行中的 DSH 数字员工运行时。使用智员的访问令牌注册后，它会领取项目任务、回流进展与结论。
      </p>
      {compact ? null : (
        <ol className="cx-guide-steps">
          <li>
            <span className="cx-guide-step__num">1</span>
            <div>
              在智员详情页的「访问令牌」创建 Agent 令牌；secret 只显示一次，请立即保存。
            </div>
          </li>
          <li>
            <span className="cx-guide-step__num">2</span>
            <div>
              调用注册接口，拿到一次性 <span className="code-inline">instance token</span>；实例随后用心跳保持在线。
            </div>
          </li>
          <li>
            <span className="cx-guide-step__num">3</span>
            <div>
              实例领取任务并上报进展；控制台的任务与实例状态会实时更新。
            </div>
          </li>
        </ol>
      )}
      <CodeBlock title="注册实例（runtime 协议）" code={REGISTER_SNIPPET} />
    </Card>
  );
}
