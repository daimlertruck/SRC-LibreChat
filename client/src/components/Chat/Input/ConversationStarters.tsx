import { useMemo, useCallback } from 'react';
import { EModelEndpoint, Constants } from 'librechat-data-provider';
import { useChatContext, useAgentsMapContext, useAssistantsMapContext } from '~/Providers';
import { useGetAssistantDocsQuery, useGetEndpointsQuery } from '~/data-provider';
import { getIconEndpoint, getEntity } from '~/utils';
import { useSubmitMessage } from '~/hooks';
import { ZapIcon } from 'lucide-react';

const ConversationStarters = () => {
  const { conversation } = useChatContext();
  const agentsMap = useAgentsMapContext();
  const assistantMap = useAssistantsMapContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();

  console.log('conversation=, ', conversation);

  const endpointType = useMemo(() => {
    let ep = conversation?.endpoint ?? '';
    if (
      [
        EModelEndpoint.chatGPTBrowser,
        EModelEndpoint.azureOpenAI,
        EModelEndpoint.gptPlugins,
      ].includes(ep as EModelEndpoint)
    ) {
      ep = EModelEndpoint.openAI;
    }
    return getIconEndpoint({
      endpointsConfig,
      iconURL: conversation?.iconURL,
      endpoint: ep,
    });
  }, [conversation?.endpoint, conversation?.iconURL, endpointsConfig]);

  const { data: documentsMap = new Map() } = useGetAssistantDocsQuery(endpointType, {
    select: (data) => new Map(data.map((dbA) => [dbA.assistant_id, dbA])),
  });

  const { entity, isAgent } = getEntity({
    endpoint: endpointType,
    agentsMap,
    assistantMap,
    agent_id: conversation?.agent_id,
    assistant_id: conversation?.assistant_id,
  });

  // TODO-1: Somehow store Agent's conversation starters in centralized storage used in this project
  // TODO-2: Write tests which test this functionality (4 most recent conversation starters to be displayed on Landing page)
  const conversation_starters: string[] = useMemo(() => {
    if (entity?.conversation_starters?.length) {
      return entity.conversation_starters;
    }

    if (isAgent) {
      return entity?.conversation_starters ?? [];
    }

    return documentsMap.get(entity?.id ?? '')?.conversation_starters ?? [];
  }, [documentsMap, isAgent, entity]);

  const { submitMessage } = useSubmitMessage();
  const sendConversationStarter = useCallback(
    (text: string) => submitMessage({ text }),
    [submitMessage],
  );

  // For testing purposes, adding some hardcoded conversation starters
  // conversation_starters.push('Welche Vorteile hat der elektrische Lkw im Vergleich zum Diesel?');
  // conversation_starters.push('Vergleiche unsere Hauptmodelle miteinander.');
  // conversation_starters.push('Nenne mir die wichtigsten Verkaufsargumente für den neuen eActros.');
  // conversation_starters.push('Welche Argumente sprechen für den Einsatz von Fleetboard?');

  // conversation_starters.push('Wofür steht Daimler Truck als Unternehmen?');
  // conversation_starters.push('Welche nachhaltigen Lösungen bietet Daimler Truck an?');  

  console.log('conversation_starters values:');
  conversation_starters.forEach((elem) => console.log(elem));

  if (!conversation_starters.length) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-col justify-center gap-1 px-4">
      <div className='flex flex-row gap-1 '>
        <ZapIcon className='text-gray-400 size-4 mt-[2px]'/>
        <p className='text-gray-400 text-[13px] font-medium pb-2'>Suggestions:</p>
      </div>
      {conversation_starters
        .slice(0, Constants.MAX_CONVO_STARTERS)
        .map((text: string, index: number) => (
          <button
            key={index}
            onClick={() => sendConversationStarter(text)}
            className="relative flex flex-col w-200 cursor-pointer gap-1 rounded-2xl  px-3 pb-2 pt-2 text-start align-top text-[15px] shadow-[0_0_2px_0_rgba(0,0,0,0.05),0_4px_6px_0_rgba(0,0,0,0.02)] transition-colors duration-300 ease-in-out fade-in hover:bg-surface-tertiary"
          >
            <p className="line-clamp-3 overflow-hidden text-balance text-text-secondary">
              {text}
            </p>
          </button>
        ))}
    </div>
  );
};

export default ConversationStarters;
