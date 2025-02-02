import createRequestBody from './createRequestBody.js'
import { defaultJsonSerializer } from './defaultJsonSerializer.js'
import { HeadersInstanceToPlainObject, uppercase } from './helpers.js'
import {
  parseBatchRequestArgs,
  parseBatchRequestsExtendedArgs,
  parseRawRequestArgs,
  parseRawRequestExtendedArgs,
  parseRequestArgs,
  parseRequestExtendedArgs,
} from './parseArgs.js'
import { resolveRequestDocument } from './resolveRequestDocument.js'
import type * as Dom from './types.dom.js'
import type {
  HTTPMethodInput,
  MaybeFunction,
  RequestConfig,
  RequestMiddleware,
  Response,
  VariablesAndRequestHeadersArgs,
} from './types.js'
import {
  BatchRequestDocument,
  BatchRequestsExtendedOptions,
  BatchRequestsOptions,
  ClientError,
  RawRequestExtendedOptions,
  RawRequestOptions,
  RequestDocument,
  RequestExtendedOptions,
  RequestOptions,
  Variables,
} from './types.js'
import type { TypedDocumentNode } from '@graphql-typed-document-node/core'
import crossFetch, * as CrossFetch from 'cross-fetch'

export {
  BatchRequestDocument,
  BatchRequestsExtendedOptions,
  BatchRequestsOptions,
  ClientError,
  RawRequestExtendedOptions,
  RawRequestOptions,
  RequestDocument,
  RequestExtendedOptions,
  RequestOptions,
  Variables,
}

/**
 * Convert the given headers configuration into a plain object.
 */
const resolveHeaders = (headers: Dom.RequestInit['headers']): Record<string, string> => {
  let oHeaders: Record<string, string> = {}
  if (headers) {
    if (
      (typeof Headers !== `undefined` && headers instanceof Headers) ||
      (CrossFetch && CrossFetch.Headers && headers instanceof CrossFetch.Headers)
    ) {
      oHeaders = HeadersInstanceToPlainObject(headers)
    } else if (Array.isArray(headers)) {
      headers.forEach(([name, value]) => {
        if (name && value !== undefined) {
          oHeaders[name] = value
        }
      })
    } else {
      oHeaders = headers as Record<string, string>
    }
  }

  return oHeaders
}

/**
 * Clean a GraphQL document to send it via a GET query
 */
const cleanQuery = (str: string): string => str.replace(/([\s,]|#[^\n\r]+)+/g, ` `).trim()

type BuildRequestConfigParamsBatch<V> = {
  query: string[]
  variables: V[] | undefined
  operationName: undefined
  jsonSerializer: Dom.JsonSerializer
}

type BuildRequestConfigParamsSingle<V> = {
  query: string
  variables: V | undefined
  operationName: string | undefined
  jsonSerializer: Dom.JsonSerializer
}

type BuildRequestConfigParams<V> = BuildRequestConfigParamsSingle<V> | BuildRequestConfigParamsBatch<V>

/**
 * Create query string for GraphQL request
 */
const buildRequestConfig = <V extends Variables>(params: BuildRequestConfigParams<V>): string => {
  if (!Array.isArray(params.query)) {
    const params_ = params as BuildRequestConfigParamsSingle<V>
    const search: string[] = [`query=${encodeURIComponent(cleanQuery(params_.query))}`]

    if (params.variables) {
      search.push(`variables=${encodeURIComponent(params_.jsonSerializer.stringify(params_.variables))}`)
    }

    if (params_.operationName) {
      search.push(`operationName=${encodeURIComponent(params_.operationName)}`)
    }

    return search.join(`&`)
  }

  if (typeof params.variables !== `undefined` && !Array.isArray(params.variables)) {
    throw new Error(`Cannot create query with given variable type, array expected`)
  }

  // Batch support
  const params_ = params as BuildRequestConfigParamsBatch<V>
  const payload = params.query.reduce<{ query: string; variables: string | undefined }[]>(
    (acc, currentQuery, index) => {
      acc.push({
        query: cleanQuery(currentQuery),
        variables: params_.variables ? params_.jsonSerializer.stringify(params_.variables[index]) : undefined,
      })
      return acc
    },
    []
  )

  return `query=${encodeURIComponent(params_.jsonSerializer.stringify(payload))}`
}

type Fetch = (url: string, config: Dom.RequestInit) => Promise<Dom.Response>

interface RequestVerbParams<V extends Variables = Variables> {
  url: string
  query: string | string[]
  fetch: Fetch
  fetchOptions: Dom.RequestInit
  variables?: V
  headers?: Dom.RequestInit['headers']
  operationName?: string
  middleware?: RequestMiddleware<V>
}

const createHttpMethodFetcher =
  (method: 'GET' | 'POST') =>
  async <V extends Variables>(params: RequestVerbParams<V>) => {
    const { url, query, variables, operationName, fetch, fetchOptions, middleware } = params

    const headers = { ...params.headers }
    let queryParams = ``
    let body = undefined

    if (method === `POST`) {
      body = createRequestBody(query, variables, operationName, fetchOptions.jsonSerializer)
      if (typeof body === `string`) {
        // @ts-expect-error todo
        headers[`Content-Type`] = `application/json`
      }
    } else {
      // @ts-expect-error todo needs ADT for TS to understand the different states
      queryParams = buildRequestConfig<V>({
        query,
        variables,
        operationName,
        jsonSerializer: fetchOptions.jsonSerializer ?? defaultJsonSerializer,
      })
    }

    const init: Dom.RequestInit = {
      method,
      headers,
      body,
      ...fetchOptions,
    }

    let urlResolved = url
    let initResolved = init
    if (middleware) {
      const result = await Promise.resolve(middleware({ ...init, url, operationName, variables }))
      const { url: urlNew, ...initNew } = result
      urlResolved = urlNew
      initResolved = initNew
    }
    if (queryParams) {
      urlResolved = `${urlResolved}?${queryParams}`
    }
    return await fetch(urlResolved, initResolved)
  }

/**
 * GraphQL Client.
 */
export class GraphQLClient {
  constructor(private url: string, public readonly requestConfig: RequestConfig = {}) {}

  /**
   * Send a GraphQL query to the server.
   */
  rawRequest: RawRequestMethod = async <T, V extends Variables = Variables>(
    ...args: RawRequestMethodArgs<V>
  ): Promise<Response<T>> => {
    const [queryOrOptions, variables, requestHeaders] = args
    const rawRequestOptions = parseRawRequestArgs<V>(queryOrOptions, variables, requestHeaders)

    const {
      headers,
      fetch = crossFetch,
      method = `POST`,
      requestMiddleware,
      responseMiddleware,
      ...fetchOptions
    } = this.requestConfig
    const { url } = this
    if (rawRequestOptions.signal !== undefined) {
      fetchOptions.signal = rawRequestOptions.signal
    }

    const { operationName } = resolveRequestDocument(rawRequestOptions.query)

    return makeRequest<T, V>({
      url,
      query: rawRequestOptions.query,
      variables: rawRequestOptions.variables as V,
      headers: {
        ...resolveHeaders(callOrIdentity(headers)),
        ...resolveHeaders(rawRequestOptions.requestHeaders),
      },
      operationName,
      fetch,
      method,
      fetchOptions,
      middleware: requestMiddleware,
    })
      .then((response) => {
        if (responseMiddleware) {
          responseMiddleware(response)
        }
        return response
      })
      .catch((error) => {
        if (responseMiddleware) {
          responseMiddleware(error)
        }
        throw error
      })
  }

  /**
   * Send a GraphQL document to the server.
   */
  async request<T, V extends Variables = Variables>(
    document: RequestDocument | TypedDocumentNode<T, V>,
    ...variablesAndRequestHeaders: VariablesAndRequestHeadersArgs<V>
  ): Promise<T>
  async request<T, V extends Variables = Variables>(options: RequestOptions<V, T>): Promise<T>
  async request<T, V extends Variables = Variables>(
    documentOrOptions: RequestDocument | TypedDocumentNode<T, V> | RequestOptions<V>,
    ...variablesAndRequestHeaders: VariablesAndRequestHeadersArgs<V>
  ): Promise<T> {
    const [variables, requestHeaders] = variablesAndRequestHeaders
    const requestOptions = parseRequestArgs(documentOrOptions, variables, requestHeaders)

    const {
      headers,
      fetch = crossFetch,
      method = `POST`,
      requestMiddleware,
      responseMiddleware,
      ...fetchOptions
    } = this.requestConfig
    const { url } = this
    if (requestOptions.signal !== undefined) {
      fetchOptions.signal = requestOptions.signal
    }

    const { query, operationName } = resolveRequestDocument(requestOptions.document)

    return makeRequest<T>({
      url,
      query,
      variables: requestOptions.variables,
      headers: {
        ...resolveHeaders(callOrIdentity(headers)),
        ...resolveHeaders(requestOptions.requestHeaders),
      },
      operationName,
      fetch,
      method,
      fetchOptions,
      middleware: requestMiddleware,
    })
      .then((response) => {
        if (responseMiddleware) {
          responseMiddleware(response)
        }
        return response.data
      })
      .catch((error) => {
        if (responseMiddleware) {
          responseMiddleware(error)
        }
        throw error
      })
  }

  /**
   * Send GraphQL documents in batch to the server.
   */
  batchRequests<T = unknown, V extends Variables = Variables>(
    documents: BatchRequestDocument<V>[],
    requestHeaders?: Dom.RequestInit['headers']
  ): Promise<T>
  batchRequests<T = unknown, V extends Variables = Variables>(options: BatchRequestsOptions<V>): Promise<T>
  batchRequests<T = unknown, V extends Variables = Variables>(
    documentsOrOptions: BatchRequestDocument<V>[] | BatchRequestsOptions<V>,
    requestHeaders?: Dom.RequestInit['headers']
  ): Promise<T> {
    const batchRequestOptions = parseBatchRequestArgs<V>(documentsOrOptions, requestHeaders)
    const { headers, ...fetchOptions } = this.requestConfig

    if (batchRequestOptions.signal !== undefined) {
      fetchOptions.signal = batchRequestOptions.signal
    }

    const queries = batchRequestOptions.documents.map(
      ({ document }) => resolveRequestDocument(document).query
    )
    const variables = batchRequestOptions.documents.map(({ variables }) => variables)

    return makeRequest<T>({
      url: this.url,
      query: queries,
      // @ts-expect-error TODO reconcile batch variables into system.
      variables,
      headers: {
        ...resolveHeaders(callOrIdentity(headers)),
        ...resolveHeaders(batchRequestOptions.requestHeaders),
      },
      operationName: undefined,
      fetch: this.requestConfig.fetch ?? crossFetch,
      method: this.requestConfig.method || `POST`,
      fetchOptions,
      middleware: this.requestConfig.requestMiddleware,
    })
      .then((response) => {
        if (this.requestConfig.responseMiddleware) {
          this.requestConfig.responseMiddleware(response)
        }
        return response.data
      })
      .catch((error) => {
        if (this.requestConfig.responseMiddleware) {
          this.requestConfig.responseMiddleware(error)
        }
        throw error
      })
  }

  setHeaders(headers: Dom.RequestInit['headers']): GraphQLClient {
    this.requestConfig.headers = headers
    return this
  }

  /**
   * Attach a header to the client. All subsequent requests will have this header.
   */
  setHeader(key: string, value: string): GraphQLClient {
    const { headers } = this.requestConfig

    if (headers) {
      // todo what if headers is in nested array form... ?
      //@ts-ignore
      headers[key] = value
    } else {
      this.requestConfig.headers = { [key]: value }
    }

    return this
  }

  /**
   * Change the client endpoint. All subsequent requests will send to this endpoint.
   */
  setEndpoint(value: string): GraphQLClient {
    this.url = value
    return this
  }
}

const makeRequest = async <T = unknown, V extends Variables = Variables>(params: {
  url: string
  query: string | string[]
  variables?: V
  headers?: Dom.RequestInit['headers']
  operationName?: string
  fetch: Fetch
  method?: HTTPMethodInput
  fetchOptions: Dom.RequestInit
  middleware?: RequestMiddleware<V>
}): Promise<Response<T>> => {
  const { query, variables, fetchOptions } = params
  const fetcher = createHttpMethodFetcher(uppercase(params.method ?? `post`))
  const isBatchingQuery = Array.isArray(params.query)
  const response = await fetcher(params)
  const result = await getResult(response, fetchOptions.jsonSerializer ?? defaultJsonSerializer)

  const successfullyReceivedData = Array.isArray(result)
    ? !result.some(({ data }) => !data)
    : Boolean(result.data)

  const successfullyPassedErrorPolicy =
    Array.isArray(result) ||
    !result.errors ||
    (Array.isArray(result.errors) && !result.errors.length) ||
    fetchOptions.errorPolicy === `all` ||
    fetchOptions.errorPolicy === `ignore`

  if (response.ok && successfullyPassedErrorPolicy && successfullyReceivedData) {
    // @ts-expect-error TODO fixme
    const { errors, ...rest } = Array.isArray(result) ? result : result
    const data = fetchOptions.errorPolicy === `ignore` ? rest : result
    const dataEnvelope = isBatchingQuery ? { data } : data

    // @ts-expect-error TODO
    return {
      ...dataEnvelope,
      headers: response.headers,
      status: response.status,
    }
  } else {
    const errorResult =
      typeof result === `string`
        ? {
            error: result,
          }
        : result
    throw new ClientError(
      // @ts-expect-error TODO
      { ...errorResult, status: response.status, headers: response.headers },
      { query, variables }
    )
  }
}

// prettier-ignore
interface RawRequestMethod {
  <T, V extends Variables = Variables>(query: string, variables?: V, requestHeaders?: Dom.RequestInit['headers']): Promise<Response<T>>
  <T, V extends Variables = Variables>(options: RawRequestOptions<V>): Promise<Response<T>>
}

// prettier-ignore
type RawRequestMethodArgs<V extends Variables> =
  | [query: string, variables?: V, requestHeaders?: Dom.RequestInit['headers']]
  | [RawRequestOptions<V>]

// prettier-ignore
interface RawRequest {
  <T, V extends Variables = Variables>(url: string, query: string, ...variablesAndRequestHeaders: VariablesAndRequestHeadersArgs<V>): Promise<Response<T>>
  <T, V extends Variables = Variables>(options: RawRequestExtendedOptions<V>): Promise<Response<T>>
}

// prettier-ignore
type RawRequestArgs<V extends Variables> = 
  | [options: RawRequestExtendedOptions<V>, query?: string, ...variablesAndRequestHeaders: VariablesAndRequestHeadersArgs<V>]
  | [url: string,                           query?: string, ...variablesAndRequestHeaders: VariablesAndRequestHeadersArgs<V>]

/**
 * Send a GraphQL Query to the GraphQL server for execution.
 */
export const rawRequest: RawRequest = async <T, V extends Variables>(
  ...args: RawRequestArgs<V>
): Promise<Response<T>> => {
  const [urlOrOptions, query, ...variablesAndRequestHeaders] = args
  const requestOptions = parseRawRequestExtendedArgs<V>(urlOrOptions, query, ...variablesAndRequestHeaders)
  const client = new GraphQLClient(requestOptions.url)
  return client.rawRequest<T, V>({
    ...requestOptions,
  })
}

/**
 * Send a GraphQL Document to the GraphQL server for execution.
 *
 * @example
 *
 * ```ts
 * // You can pass a raw string
 *
 * await request('https://foo.bar/graphql', `
 *   {
 *     query {
 *       users
 *     }
 *   }
 * `)
 *
 * // You can also pass a GraphQL DocumentNode. Convenient if you
 * // are using graphql-tag package.
 *
 * import gql from 'graphql-tag'
 *
 * await request('https://foo.bar/graphql', gql`...`)
 *
 * // If you don't actually care about using DocumentNode but just
 * // want the tooling support for gql template tag like IDE syntax
 * // coloring and prettier autoformat then note you can use the
 * // passthrough gql tag shipped with graphql-request to save a bit
 * // of performance and not have to install another dep into your project.
 *
 * import { gql } from 'graphql-request'
 *
 * await request('https://foo.bar/graphql', gql`...`)
 * ```
 */
export async function request<T, V extends Variables = Variables>(
  url: string,
  // @ts-ignore
  document: RequestDocument | TypedDocumentNode<T, V>,
  ...variablesAndRequestHeaders: VariablesAndRequestHeadersArgs<V>
): Promise<T>
export async function request<T, V extends Variables = Variables>(
  options: RequestExtendedOptions<V, T>
): Promise<T>
export async function request<T, V extends Variables = Variables>(
  urlOrOptions: string | RequestExtendedOptions<V, T>,
  // @ts-ignore
  document?: RequestDocument | TypedDocumentNode<T, V>,
  ...variablesAndRequestHeaders: VariablesAndRequestHeadersArgs<V>
): Promise<T> {
  // @ts-ignore
  const requestOptions = parseRequestExtendedArgs<V>(urlOrOptions, document, ...variablesAndRequestHeaders)
  const client = new GraphQLClient(requestOptions.url)
  return client.request<T, V>({
    ...requestOptions,
  })
}

/**
 * Send a batch of GraphQL Document to the GraphQL server for execution.
 *
 * @example
 *
 * ```ts
 * // You can pass a raw string
 *
 * await batchRequests('https://foo.bar/graphql', [
 * {
 *  query: `
 *   {
 *     query {
 *       users
 *     }
 *   }`
 * },
 * {
 *   query: `
 *   {
 *     query {
 *       users
 *     }
 *   }`
 * }])
 *
 * // You can also pass a GraphQL DocumentNode as query. Convenient if you
 * // are using graphql-tag package.
 *
 * import gql from 'graphql-tag'
 *
 * await batchRequests('https://foo.bar/graphql', [{ query: gql`...` }])
 * ```
 */
export async function batchRequests<T, V extends Variables = Variables>(
  url: string,
  documents: BatchRequestDocument<V>[],
  requestHeaders?: Dom.RequestInit['headers']
): Promise<T>
export async function batchRequests<T, V extends Variables = Variables>(
  options: BatchRequestsExtendedOptions<V>
): Promise<T>
export async function batchRequests<T, V extends Variables = Variables>(
  urlOrOptions: string | BatchRequestsExtendedOptions<V>,
  documents?: BatchRequestDocument<V>[],
  requestHeaders?: Dom.RequestInit['headers']
): Promise<T> {
  const params = parseBatchRequestsExtendedArgs<V>(urlOrOptions, documents, requestHeaders)
  const client = new GraphQLClient(params.url)
  return client.batchRequests<T, V>(params)
}

export default request

const getResult = async (
  response: Dom.Response,
  jsonSerializer: Dom.JsonSerializer
): Promise<
  | { data: object; errors: undefined }[]
  | { data: object; errors: undefined }
  | { data: undefined; errors: object }
  | { data: undefined; errors: object[] }
> => {
  let contentType: string | undefined

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === `content-type`) {
      contentType = value
    }
  })

  if (
    contentType &&
    (contentType.toLowerCase().startsWith(`application/json`) ||
      contentType.toLowerCase().startsWith(`application/graphql+json`) ||
      contentType.toLowerCase().startsWith(`application/graphql-response+json`))
  ) {
    return jsonSerializer.parse(await response.text()) as any
  } else {
    return response.text() as any
  }
}

const callOrIdentity = <T>(value: MaybeFunction<T>) => {
  return typeof value === `function` ? (value as () => T)() : value
}

/**
 * Convenience passthrough template tag to get the benefits of tooling for the gql template tag. This does not actually parse the input into a GraphQL DocumentNode like graphql-tag package does. It just returns the string with any variables given interpolated. Can save you a bit of performance and having to install another package.
 *
 * @example
 *
 * import { gql } from 'graphql-request'
 *
 * await request('https://foo.bar/graphql', gql`...`)
 *
 * @remarks
 *
 * Several tools in the Node GraphQL ecosystem are hardcoded to specially treat any template tag named "gql". For example see this prettier issue: https://github.com/prettier/prettier/issues/4360. Using this template tag has no runtime effect beyond variable interpolation.
 */
export const gql = (chunks: TemplateStringsArray, ...variables: any[]): string => {
  return chunks.reduce(
    (accumulator, chunk, index) => `${accumulator}${chunk}${index in variables ? variables[index] : ``}`,
    ``
  )
}

export { GraphQLWebSocketClient } from './graphql-ws.js'
export { resolveRequestDocument } from './resolveRequestDocument.js'
