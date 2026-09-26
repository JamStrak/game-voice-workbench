import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Circle, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { useExpressionCapabilities } from '@/lib/hooks/useExpression';

function ModelCard({
  name,
  description,
  ready,
  pending,
  error,
  note,
}: {
  name: string;
  description: string;
  ready: boolean;
  pending: boolean;
  error: boolean;
  note: string;
}) {
  const Icon = pending ? Loader2 : ready ? CheckCircle2 : Circle;
  return (
    <article className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">{name}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        <Badge variant={ready ? 'secondary' : 'outline'} className="shrink-0 gap-1.5">
          <Icon className={`h-3.5 w-3.5 ${pending ? 'animate-spin' : ''}`} aria-hidden="true" />
          {pending ? '读取中' : error ? '状态不可用' : ready ? '文件已就绪' : '待安装'}
        </Badge>
      </div>
      <p className="mt-4 border-t pt-3 text-sm leading-6 text-muted-foreground">{note}</p>
    </article>
  );
}

export function ModelsTab() {
  const models = useQuery({
    queryKey: ['modelStatus'],
    queryFn: () => apiClient.getModelStatus(),
    staleTime: 30000,
    refetchInterval: 60000,
    retry: 1,
  });
  const expression = useExpressionCapabilities();
  const refreshing = models.isFetching || expression.isFetching;
  const available = (name: string) =>
    !!models.data?.models.find((model) => model.model_name === name)?.downloaded;

  return (
    <div className="h-full overflow-y-auto pb-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">本地模型</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              模型准备一次，之后在本机生成配音。声音库试听无需安装模型。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => {
              void models.refetch();
              void expression.refetch();
            }}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            刷新状态
          </Button>
        </header>

        <section className="rounded-xl border bg-muted/30 p-5" aria-label="安装方法">
          <div className="flex items-center gap-2 font-medium">
            <FolderOpen className="h-4 w-4" aria-hidden="true" />
            从解压后的工具文件夹安装
          </div>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
            <li>
              双击 <strong className="font-medium text-foreground">安装配音工作台.vbs</strong>
              ，完成基础配音环境和 Qwen 模型下载。
            </li>
            <li>
              需要指定情绪或自动分析时，再双击{' '}
              <strong className="font-medium text-foreground">安装情绪引擎.vbs</strong>。
            </li>
            <li>安装完成后回到这里刷新状态。下载中断可以重新运行安装器，已校验的文件会保留。</li>
          </ol>
          <p className="mt-3 text-sm text-muted-foreground">
            本地生成需要 NVIDIA 显卡及兼容驱动。情绪合成开始前还会检查可用内存与显存。
          </p>
        </section>

        {(models.isError || expression.isError) && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
          >
            暂时无法读取完整状态，请确认配音工作台仍在运行，然后点击刷新。
          </p>
        )}

        <div className="space-y-4">
          <ModelCard
            name="预设角色配音 · Qwen CustomVoice 0.6B"
            description="使用声音库的 9 种预设音色，为新台词生成自然语气的配音。"
            ready={available('qwen-custom-voice-0.6B')}
            pending={models.isLoading}
            error={models.isError}
            note="包含在基础安装中。开心、愤怒等表达需要下面的情绪引擎。"
          />
          <ModelCard
            name="参考声音配音 · Qwen Base 0.6B"
            description="使用你有权使用的参考录音创建个人声音，再生成新的台词。"
            ready={available('qwen-tts-0.6B')}
            pending={models.isLoading}
            error={models.isError}
            note="包含在基础安装中。模型在每次生成任务的独立进程中加载，完成后释放。"
          />
          <ModelCard
            name="情绪配音 · IndexTTS 2.5"
            description="保留选定声音的参考特征，支持手动指定情绪；安装分析模型后可根据台词自动分析。"
            ready={!!expression.data?.ready}
            pending={expression.isLoading}
            error={expression.isError}
            note={
              expression.data?.ready
                ? expression.data.analyzer_ready
                  ? '手动情绪与自动分析均已就绪。'
                  : '手动情绪已就绪；自动分析尚未准备完成。'
                : '可选安装，模型较大。具体使用条件请阅读发行包中的第三方许可说明。'
            }
          />
        </div>

        <p className="text-sm text-muted-foreground">
          还没准备好生成环境？先到{' '}
          <Link to="/voices" className="font-medium text-foreground underline underline-offset-4">
            声音库
          </Link>
          试听已经内置的角色声音。
        </p>
      </div>
    </div>
  );
}
