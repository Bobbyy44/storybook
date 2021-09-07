import dedent from 'ts-dedent';
import deprecate from 'util-deprecate';
import global from 'global';

import {
  Parameters,
  Args,
  LegacyStoryFn,
  ArgsStoryFn,
  StoryContextForEnhancers,
  StoryContext,
  AnyFramework,
  StrictArgTypes,
} from '@storybook/csf';

import {
  NormalizedComponentAnnotations,
  Story,
  NormalizedStoryAnnotations,
  NormalizedProjectAnnotations,
} from './types';
import { combineParameters } from './parameters';
import { applyHooks } from './hooks';
import { defaultDecorateStory } from './decorators';

const argTypeDefaultValueWarning = deprecate(
  () => {},
  dedent`
  \`argType.defaultValue\` is deprecated and will be removed in Storybook 7.0.

  https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#deprecated-argtype-defaultValue`
);

// Combine all the metadata about a story (both direct and inherited from the component/global scope)
// into a "renderable" story function, with all decorators applied, parameters passed as context etc
//
// Note that this story function is *stateless* in the sense that it does not track args or globals
// Instead, it is expected these are tracked separately (if necessary) and are passed into each invocation.
export function prepareStory<TFramework extends AnyFramework>(
  storyAnnotations: NormalizedStoryAnnotations<TFramework>,
  componentAnnotations: NormalizedComponentAnnotations<TFramework>,
  projectAnnotations: NormalizedProjectAnnotations<TFramework>
): Story<TFramework> {
  // NOTE: in the current implementation we are doing everything once, up front, rather than doing
  // anything at render time. The assumption is that as we don't load all the stories at once, this
  // will have a limited cost. If this proves misguided, we can refactor it.

  const { id, name } = storyAnnotations;
  const { title } = componentAnnotations;

  const parameters: Parameters = combineParameters(
    projectAnnotations.parameters,
    componentAnnotations.parameters,
    storyAnnotations.parameters
  );

  const decorators = [
    ...(storyAnnotations.decorators || []),
    ...(componentAnnotations.decorators || []),
    ...(projectAnnotations.decorators || []),
  ];

  // Currently it is only possible to set these globally
  const {
    applyDecorators = defaultDecorateStory,
    argTypesEnhancers = [],
    argsEnhancers = [],
  } = projectAnnotations;

  const loaders = [
    ...(projectAnnotations.loaders || []),
    ...(componentAnnotations.loaders || []),
    ...(storyAnnotations.loaders || []),
  ];

  // TODO make a note about what's happening here
  const render =
    storyAnnotations.userStoryFn ||
    storyAnnotations.render ||
    componentAnnotations.render ||
    projectAnnotations.render;

  const passedArgTypes: StrictArgTypes = combineParameters(
    projectAnnotations.argTypes,
    componentAnnotations.argTypes,
    storyAnnotations.argTypes
  ) as StrictArgTypes;

  const { passArgsFirst = true } = parameters;
  // eslint-disable-next-line no-underscore-dangle
  parameters.__isArgsStory = passArgsFirst && render.length > 0;

  // Pull out args[X] || argTypes[X].defaultValue into initialArgs
  const passedArgs: Args = combineParameters(
    projectAnnotations.args,
    componentAnnotations.args,
    storyAnnotations.args
  ) as Args;

  const defaultArgs: Args = Object.entries(
    passedArgTypes as Record<string, { defaultValue: any }>
  ).reduce((acc, [arg, { defaultValue }]) => {
    if (typeof defaultValue !== 'undefined') {
      acc[arg] = defaultValue;
    }
    return acc;
  }, {} as Args);
  if (Object.keys(defaultArgs).length > 0) {
    argTypeDefaultValueWarning();
  }

  const initialArgsBeforeEnhancers = { ...defaultArgs, ...passedArgs };
  const contextForEnhancers: StoryContextForEnhancers<TFramework> = {
    componentId: componentAnnotations.id,
    title,
    kind: title, // Back compat
    id,
    name,
    story: name, // Back compat
    component: componentAnnotations.component,
    subcomponents: componentAnnotations.subcomponents,
    parameters,
    initialArgs: initialArgsBeforeEnhancers,
    argTypes: passedArgTypes,
  };

  contextForEnhancers.initialArgs = argsEnhancers.reduce(
    (accumulatedArgs: Args, enhancer) => ({
      ...accumulatedArgs,
      ...enhancer({
        ...contextForEnhancers,
        initialArgs: initialArgsBeforeEnhancers,
      }),
    }),
    initialArgsBeforeEnhancers
  );

  contextForEnhancers.argTypes = argTypesEnhancers.reduce(
    (accumulatedArgTypes, enhancer) =>
      enhancer({ ...contextForEnhancers, argTypes: accumulatedArgTypes }),
    contextForEnhancers.argTypes
  );

  // Add some of our metadata into parameters as we used to do this in 6.x and users may be relying on it
  if (!global.FEATURES?.breakingChangesV7) {
    contextForEnhancers.parameters = {
      ...contextForEnhancers.parameters,
      __id: id,
      globalTypes: projectAnnotations.globalTypes,
      args: contextForEnhancers.initialArgs,
      argTypes: contextForEnhancers.argTypes,
    };
  }

  const applyLoaders = async (context: StoryContext<TFramework>) => {
    const loadResults = await Promise.all(loaders.map((loader) => loader(context)));
    const loaded = Object.assign({}, ...loadResults);
    return { ...context, loaded };
  };

  const undecoratedStoryFn: LegacyStoryFn<TFramework> = (context: StoryContext<TFramework>) => {
    const mappedArgs = Object.entries(context.args).reduce((acc, [key, val]) => {
      const mapping = context.argTypes[key]?.mapping;
      acc[key] = mapping && val in mapping ? mapping[val] : val;
      return acc;
    }, {} as Args);

    const mappedContext = { ...context, args: mappedArgs };
    const { passArgsFirst: renderTimePassArgsFirst = true } = context.parameters;
    return renderTimePassArgsFirst
      ? (render as ArgsStoryFn<TFramework>)(mappedArgs, mappedContext)
      : (render as LegacyStoryFn<TFramework>)(mappedContext);
  };
  const unboundStoryFn = applyHooks<TFramework>(applyDecorators)(undecoratedStoryFn, decorators);

  const { play } = storyAnnotations;
  const runPlayFunction = async () => {
    if (play) {
      return play();
    }
    return undefined;
  };

  return Object.freeze({
    ...contextForEnhancers,
    originalStoryFn: render,
    undecoratedStoryFn,
    unboundStoryFn,
    applyLoaders,
    runPlayFunction,
  });
}
