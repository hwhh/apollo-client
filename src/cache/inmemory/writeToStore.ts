import {SelectionSetNode, FieldNode, DocumentNode} from 'graphql';
import {invariant, InvariantError} from 'ts-invariant';
import {equal} from '@wry/equality';
import queue, {Queue, Worker} from 'react-native-job-queue'
import {
    createFragmentMap,
    FragmentMap,
    getFragmentFromSelection,
} from '../../utilities/graphql/fragments';

import {
    getDefaultValues,
    getFragmentDefinitions,
    getOperationDefinition,
} from '../../utilities/graphql/getFromAST';

import {
    getTypenameFromResult,
    makeReference,
    isField,
    resultKeyNameFromField,
    StoreValue,
    StoreObject,
    Reference,
    isReference,
} from '../../utilities/graphql/storeUtils';

import {shouldInclude, hasDirectives} from '../../utilities/graphql/directives';
import {cloneDeep} from '../../utilities/common/cloneDeep';

import {NormalizedCache, ReadMergeModifyContext} from './types';
import {makeProcessedFieldsMerger, FieldValueToBeMerged, fieldNameFromStoreName} from './helpers';
import {StoreReader} from './readFromStore';
import {InMemoryCache} from "./inMemoryCache";


export interface WriteContext extends ReadMergeModifyContext {
    readonly written: {
        [dataId: string]: SelectionSetNode[];
    };
    readonly fragmentMap?: FragmentMap;

    // General-purpose deep-merge function for use during writes.
    merge<T>(existing: T, incoming: T): T;
};

interface ProcessSelectionSetOptions {
    dataId?: string,
    result: Record<string, any>;
    selectionSet: SelectionSetNode;
    context: WriteContext;
    out?: {
        shouldApplyMerges: boolean;
    };
}

export interface WriteToStoreOptions {
    query: DocumentNode;
    result: Object;
    dataId?: string;
    store: NormalizedCache;
    variables?: Object;
}

export class StoreWriter {

    private queue: Queue
    public cache: InMemoryCache
    private reader?: StoreReader

    constructor(cache: InMemoryCache, reader: StoreReader) {
        this.cache = cache;
        this.reader = reader;
        this.queue = queue;
        this.queue.configure({
            onQueueFinish: (executedJobs) => {
                console.log('Queue stopped and executed', executedJobs);
                this.cache.gc();
                return executedJobs;
            },
            updateInterval: 600000
        });
        this.queue.addWorker(
            new Worker('removeCacheEntry', async (payload) => {
                return new Promise((resolve) => {
                    console.log('Evicting:  ' + payload.id)
                    this.cache.evict(payload.id);
                    resolve();
                });
            }, {
                concurrency: 10
            }),
        );

    }

    /**
     * Writes the result of a query to the store.
     *
     * @param result The result object returned for the query document.
     *
     * @param query The query document whose result we are writing to the store.
     *
     * @param store The {@link NormalizedCache} used by Apollo for the `data` portion of the store.
     *
     * @param variables A map from the name of a variable to its value. These variables can be
     * referenced by the query document.
     *
     * @return A `Reference` to the written object.
     */
    public writeToStore({
                            query,
                            result,
                            dataId,
                            store,
                            variables,
                        }: WriteToStoreOptions): Reference | undefined {
        const operationDefinition = getOperationDefinition(query)!;
        const merger = makeProcessedFieldsMerger();

        variables = {
            ...getDefaultValues(operationDefinition),
            ...variables,
        };

        const objOrRef = this.processSelectionSet({
            result: result || Object.create(null),
            dataId,
            selectionSet: operationDefinition.selectionSet,
            context: {
                store,
                written: Object.create(null),
                merge<T>(existing: T, incoming: T) {
                    return merger.merge(existing, incoming) as T;
                },
                variables,
                varString: JSON.stringify(variables),
                fragmentMap: createFragmentMap(getFragmentDefinitions(query)),
            },
        });

        const ref = isReference(objOrRef) ? objOrRef :
            dataId && makeReference(dataId) || void 0;
        if (ref) {
            // Any IDs written explicitly to the cache (including ROOT_QUERY,
            // most frequently) will be retained as reachable root IDs.
            store.retain(ref.__ref);
        }

        return ref;
    }

    private processSelectionSet({
                                    dataId,
                                    result,
                                    selectionSet,
                                    context,
                                    // This object allows processSelectionSet to report useful information
                                    // to its callers without explicitly returning that information.
                                    out = {
                                        shouldApplyMerges: false,
                                    },
                                }: ProcessSelectionSetOptions): StoreObject | Reference {
        const {policies} = this.cache;

        // Identify the result object, even if dataId was already provided,
        // since we always need keyObject below.
        const [id, keyObject] = policies.identify(
            result, selectionSet, context.fragmentMap);

        // If dataId was not provided, fall back to the id just generated by
        // policies.identify.
        dataId = dataId || id;

        if ("string" === typeof dataId) {
            // Avoid processing the same entity object using the same selection
            // set more than once. We use an array instead of a Set since most
            // entity IDs will be written using only one selection set, so the
            // size of this array is likely to be very small, meaning indexOf is
            // likely to be faster than Set.prototype.has.
            const sets = context.written[dataId] || (context.written[dataId] = []);
            const ref = makeReference(dataId);
            if (sets.indexOf(selectionSet) >= 0) return ref;
            sets.push(selectionSet);

            // If we're about to write a result object into the store, but we
            // happen to know that the exact same (===) result object would be
            // returned if we were to reread the result with the same inputs,
            // then we can skip the rest of the processSelectionSet work for
            // this object, and immediately return a Reference to it.
            if (this.reader && this.reader.isFresh(
                result,
                ref,
                selectionSet,
                context,
            )) {
                return ref;
            }
        }

        // This mergedFields variable will be repeatedly updated using context.merge
        // to accumulate all fields that need to be written into the store.
        let mergedFields: StoreObject = Object.create(null);

        // Write any key fields that were used during identification, even if
        // they were not mentioned in the original query.
        if (keyObject) {
            mergedFields = context.merge(mergedFields, keyObject);
        }

        // If typename was not passed in, infer it. Note that typename is
        // always passed in for tricky-to-infer cases such as "Query" for
        // ROOT_QUERY.
        const typename =
            (dataId && policies.rootTypenamesById[dataId]) ||
            getTypenameFromResult(result, selectionSet, context.fragmentMap) ||
            (dataId && context.store.get(dataId, "__typename") as string);

        if ("string" === typeof typename) {
            mergedFields.__typename = typename;
        }

        const workSet = new Set(selectionSet.selections);


        workSet.forEach(selection => {
            if (!shouldInclude(selection, context.variables)) return;

            if (isField(selection)) {
                const resultFieldKey = resultKeyNameFromField(selection);
                const value = result[resultFieldKey];

                if (typeof value !== 'undefined') {
                    const storeFieldName = policies.getStoreFieldName({
                        typename,
                        fieldName: selection.name.value,
                        field: selection,
                        variables: context.variables,
                    });

                    let incomingValue =
                        this.processFieldValue(value, selection, context, out);

                    if (policies.hasMergeFunction(typename, selection.name.value)) {
                        // If a custom merge function is defined for this field, store
                        // a special FieldValueToBeMerged object, so that we can run
                        // the merge function later, after all processSelectionSet
                        // work is finished.
                        incomingValue = {
                            __field: selection,
                            __typename: typename,
                            __value: incomingValue,
                        } as FieldValueToBeMerged;

                        // Communicate to the caller that mergedFields contains at
                        // least one FieldValueToBeMerged.
                        out.shouldApplyMerges = true;
                    }

                    mergedFields = context.merge(mergedFields, {
                        [storeFieldName]: incomingValue,
                    });

                } else if (
                    policies.usingPossibleTypes &&
                    !hasDirectives(["defer", "client"], selection)
                ) {
                    throw new InvariantError(
                        `Missing field '${resultFieldKey}' in ${JSON.stringify(
                            result,
                            null,
                            2,
                        ).substring(0, 100)}`,
                    );
                }
            } else {
                // This is not a field, so it must be a fragment, either inline or named
                const fragment = getFragmentFromSelection(
                    selection,
                    context.fragmentMap,
                );

                if (fragment && policies.fragmentMatches(fragment, typename)) {
                    fragment.selectionSet.selections.forEach(workSet.add, workSet);
                }
            }
        });

        if ("string" === typeof dataId) {
            const entityRef = makeReference(dataId);

            if (out.shouldApplyMerges) {
                mergedFields = policies.applyMerges(entityRef, mergedFields, context);
            }

            if (process.env.NODE_ENV !== "production") {
                Object.keys(mergedFields).forEach(storeFieldName => {
                    const fieldName = fieldNameFromStoreName(storeFieldName);
                    // If a merge function was defined for this field, trust that it
                    // did the right thing about (not) clobbering data.
                    if (!policies.hasMergeFunction(typename, fieldName)) {
                        warnAboutDataLoss(
                            entityRef,
                            mergedFields,
                            storeFieldName,
                            context.store,
                        );
                    }
                });
            }
            if (dataId !== 'ROOT_QUERY' && mergedFields.maxAge) {
                this.queue.getJobs().then((jobs) => {
                    const existingJob = jobs.find(e => JSON.parse(e.payload).id === dataId)
                    if (existingJob === undefined) {
                        console.log(dataId + ' will be evicted from the cache on: ', new Date(Number(mergedFields.maxAge)).toISOString())
                        this.queue.addJob('removeCacheEntry', {
                            id: dataId,
                            executionTime: new Date(Number(mergedFields.maxAge)).toISOString(),
                        });
                    } else {
                        this.queue.updateJobExecutionTime({
                            ...existingJob,
                            executionTime: new Date(Number(mergedFields.maxAge)).toISOString()
                        }).then((success) => {
                            if (!success){
                                this.queue.addJob('removeCacheEntry', {
                                    id: dataId,
                                    executionTime: new Date(new Date().getTime() + 30000).toISOString(),
                                });
                            }
                        })
                    }
                })
            }
            context.store.merge(dataId, mergedFields);

            return entityRef;
        }

        return mergedFields;
    }

    private processFieldValue(
        value: any,
        field: FieldNode,
        context: WriteContext,
        out: ProcessSelectionSetOptions["out"],
    ): StoreValue {
        if (!field.selectionSet || value === null) {
            // In development, we need to clone scalar values so that they can be
            // safely frozen with maybeDeepFreeze in readFromStore.ts. In production,
            // it's cheaper to store the scalar values directly in the cache.
            return process.env.NODE_ENV === 'production' ? value : cloneDeep(value);
        }

        if (Array.isArray(value)) {
            return value.map(item => this.processFieldValue(item, field, context, out));
        }

        return this.processSelectionSet({
            result: value,
            selectionSet: field.selectionSet,
            context,
            out,
        });
    }
}

const warnings = new Set<string>();

// Note that this function is unused in production, and thus should be
// pruned by any well-configured minifier.
function warnAboutDataLoss(
    existingRef: Reference,
    incomingObj: StoreObject,
    storeFieldName: string,
    store: NormalizedCache,
) {
    const getChild = (objOrRef: StoreObject | Reference): StoreObject | false => {
        const child = store.getFieldValue<StoreObject>(objOrRef, storeFieldName);
        return typeof child === "object" && child;
    };

    const existing = getChild(existingRef);
    if (!existing) return;

    const incoming = getChild(incomingObj);
    if (!incoming) return;

    // It's always safe to replace a reference, since it refers to data
    // safely stored elsewhere.
    if (isReference(existing)) return;

    // If the values are structurally equivalent, we do not need to worry
    // about incoming replacing existing.
    if (equal(existing, incoming)) return;

    // If we're replacing every key of the existing object, then the
    // existing data would be overwritten even if the objects were
    // normalized, so warning would not be helpful here.
    if (Object.keys(existing).every(
        key => store.getFieldValue(incoming, key) !== void 0)) {
        return;
    }

    const parentType =
        store.getFieldValue<string>(existingRef, "__typename") ||
        store.getFieldValue<string>(incomingObj, "__typename");
    const fieldName = fieldNameFromStoreName(storeFieldName);
    const typeDotName = `${parentType}.${fieldName}`;
    // Avoid warning more than once for the same type and field name.
    if (warnings.has(typeDotName)) return;
    warnings.add(typeDotName);

    const childTypenames: string[] = [];
    // Arrays do not have __typename fields, and always need a custom merge
    // function, even if their elements are normalized entities.
    if (!Array.isArray(existing) &&
        !Array.isArray(incoming)) {
        [existing, incoming].forEach(child => {
            const typename = store.getFieldValue(child, "__typename");
            if (typeof typename === "string" &&
                !childTypenames.includes(typename)) {
                childTypenames.push(typename);
            }
        });
    }

    invariant.warn(
        `Cache data may be lost when replacing the ${fieldName} field of a ${parentType} object.

To address this problem (which is not a bug in Apollo Client), ${
            childTypenames.length
                ? "either ensure all objects of type " +
                childTypenames.join(" and ") + " have IDs, or "
                : ""
        }define a custom merge function for the ${
            typeDotName
        } field, so InMemoryCache can safely merge these objects:

  existing: ${JSON.stringify(existing).slice(0, 1000)}
  incoming: ${JSON.stringify(incoming).slice(0, 1000)}

For more information about these options, please refer to the documentation:

  * Ensuring entity objects have IDs: https://go.apollo.dev/c/generating-unique-identifiers
  * Defining custom merge functions: https://go.apollo.dev/c/merging-non-normalized-objects
`);
}
