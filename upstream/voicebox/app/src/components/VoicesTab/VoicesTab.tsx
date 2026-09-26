import { AudioLines, Library, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PersonalVoices } from './PersonalVoices';
import { VoiceLibrary } from './VoiceLibrary';

export function VoicesTab() {
  const [tab, setTab] = useState('library');
  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <header className="shrink-0 space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
            <AudioLines className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">声音库</h1>
            <p className="mt-1 text-sm text-muted-foreground">先听见角色，再开始写他的故事。</p>
          </div>
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mb-4 w-fit shrink-0" aria-label="声音来源">
          <TabsTrigger value="library" className="gap-2">
            <Library className="h-4 w-4" />
            内置声音库
          </TabsTrigger>
          <TabsTrigger value="personal" className="gap-2">
            <UserRound className="h-4 w-4" />
            我的声音
          </TabsTrigger>
        </TabsList>
        <TabsContent value="library" className="m-0 min-h-0 flex-1">
          <VoiceLibrary onVariantSaved={() => setTab('personal')} />
        </TabsContent>
        <TabsContent value="personal" className="m-0 min-h-0 flex-1">
          <PersonalVoices />
        </TabsContent>
      </Tabs>
    </div>
  );
}
