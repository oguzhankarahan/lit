/**
 * @license
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// tslint:disable:no-new-decorators

import {customElement, html} from 'lit-element';
import {computed, observable} from 'mobx';

import {app} from '../core/lit_app';
import {LitModule} from '../core/lit_module';
import {TableData} from '../elements/table';
import {CallConfig, FacetMap, IndexedInput, ModelInfoMap, Spec} from '../lib/types';
import {GroupService} from '../services/group_service';
import {ClassificationService, SliceService} from '../services/services';

import {styles} from './metrics_module.css';
import {styles as sharedStyles} from './shared_styles.css';

// Each entry from the server.
interface MetricsResponse {
  'pred_key': string;
  'label_key': string;
  'metrics': MetricsValues;
}

interface ModelHeadMetrics {
  [metricsType: string]: MetricsValues;
}

interface MetricsValues {
  [metricName: string]: number;
}

enum Source {
  DATASET = "dataset",
  SELECTION = "selection",
  SLICE = "slice"
}

// For rendering the table.
interface MetricsRow {
  'model': string;
  'selection': string;
  'predKey': string;
  'exampleIds': string[];
  'headMetrics': ModelHeadMetrics;
  'source': Source;
  'facets'?: FacetMap;
}

interface MetricsMap {
  [rowKey: string]: MetricsRow;
}

interface TableHeaderAndData {
  'header': string[];
  'data': TableData[];
}

/**
 * Module to show metrics of a model.
 */
@customElement('metrics-module')
export class MetricsModule extends LitModule {
  static title = 'Metrics';
  static numCols = 8;
  static template = () => {
    return html`<metrics-module></metrics-module>`;
  };
  static duplicateForModelComparison = false;

  static get styles() {
    return [sharedStyles, styles];
  }

  private readonly sliceService = app.getService(SliceService);
  private readonly groupService = app.getService(GroupService);
  private readonly classificationService =
      app.getService(ClassificationService);

  @observable private metricsMap: MetricsMap = {};
  @observable private facetBySlice: boolean = false;
  @observable private selectedFacets: string[] = [];
  @observable private pendingCalls = 0;


  firstUpdated() {
    this.react(() => this.appState.currentInputData, entireDataset => {
      this.addMetrics(this.appState.currentInputData, Source.DATASET);
      this.updateAllFacetedMetrics();
    });
    this.reactImmediately(() => this.selectionService.selectedInputData, () => {
      Object.keys(this.metricsMap).forEach(key => {
        if (this.metricsMap[key].source === Source.SELECTION) {
          delete this.metricsMap[key];
        }
      });
      if (this.selectionService.selectedInputData.length > 0) {
        this.addMetrics(this.selectionService.selectedInputData,
                        Source.SELECTION);
        this.updateFacetedMetrics(this.selectionService.selectedInputData,
                                  true);
      }
    });
    this.react(() => this.classificationService.allMarginSettings, margins => {
      this.addMetrics(this.appState.currentInputData, Source.DATASET);
      this.updateAllFacetedMetrics();
    });
    this.react(() => this.sliceService.sliceNames, slices => {
      this.facetBySlice = true;
      this.updateSliceMetrics();
    });

    // Do this once, manually, to avoid duplicate calls on load.
    this.addMetrics(this.appState.currentInputData, Source.DATASET);
    this.updateAllFacetedMetrics();
  }

  /** Gets and adds metrics information for datapoints to the metricsMap. */
  async addMetrics(datapoints: IndexedInput[], source: Source,
                   facetMap?: FacetMap, displayName?: string) {
    const models = this.appState.currentModels;

    // Get the metrics for all models for the provided datapoints, tracking
    // pending calls for the loading spinner.
    this.pendingCalls += 1;
    let datasetMetrics = [];
    try {
      datasetMetrics = await Promise.all(models.map(
        async (model: string) => this.getMetrics(datapoints, model)));
      this.pendingCalls -= 1;
    } catch {
      this.pendingCalls -= 1;
    }

    let name = displayName != null ? displayName : source.toString();
    if (facetMap !=null) {
      name += ' (faceted)';
    }

    // Add the returned metrics for each model and head to the metricsMap.
    datasetMetrics.forEach((returnedMetrics, i) => {
      Object.keys(returnedMetrics).forEach(metricsType => {
        const metricsRespones: MetricsResponse[] = returnedMetrics[metricsType];
        metricsRespones.forEach(metricsResponse => {
          const rowKey = this.getRowKey(
              models[i], name, metricsResponse.pred_key, facetMap);
          if (this.metricsMap[rowKey] == null) {
            this.metricsMap[rowKey] = {
              model: models[i],
              selection: name,
              exampleIds: datapoints.map(datapoint => datapoint.id),
              predKey: metricsResponse.pred_key,
              headMetrics: {},
              facets: facetMap,
              source
            };
          }
          this.metricsMap[rowKey].exampleIds = datapoints.map(
              datapoint => datapoint.id);

          // Each model/datapoints/head combination stores a dict of metrics
          // for the different metrics generators run by LIT.
          this.metricsMap[rowKey].headMetrics[metricsType] =
              metricsResponse.metrics;
        });
      });
    });
  }

  /** Returns a MetricsRow key based on arguments. */
  getRowKey(model: string, datapointsId: string, predKey: string,
            facetMap?: FacetMap) {
    let facetString = '';
    if (facetMap != null) {
      Object.values(facetMap).forEach(facetVal => {
        facetString += `${facetVal}-`;
      });
    }
    return `${model}-${datapointsId}-${predKey}-${facetString}`;
  }

  private updateFacetedMetrics(datapoints: IndexedInput[],
                               isSelection: boolean ) {
    // Get the intersectional feature bins.
    if (this.selectedFacets.length > 0) {
      const groupedExamples =
          this.groupService.groupExamplesByFeatures(datapoints,
                                                    this.selectedFacets);

      const source =  isSelection ? Source.SELECTION : Source.DATASET;
      // Manually set all of their display names.
      Object.keys(groupedExamples).forEach(key => {
        this.addMetrics(groupedExamples[key].data, source,
                        groupedExamples[key].facets);
      });
    }
  }

  private updateAllFacetedMetrics() {
    Object.keys(this.metricsMap).forEach(key => {
      if (this.metricsMap[key].facets != null) {
        delete this.metricsMap[key];
      }
    });
    // Get the intersectional feature bins.
    if (this.selectedFacets.length > 0) {
      this.updateFacetedMetrics(this.selectionService.selectedInputData, true);
      this.updateFacetedMetrics(this.appState.currentInputData, false);
    }
  }

  /**
   * Facet the data by slices.
   */
  private updateSliceMetrics() {
    Object.keys(this.metricsMap).forEach(key => {
      if (this.metricsMap[key].source === Source.SLICE) {
        delete this.metricsMap[key];
      }
    });
    if (this.facetBySlice) {
      this.sliceService.sliceNames.forEach(name => {
        const data = this.sliceService.getSliceDataByName(name);
        if (data.length > 0) {
          this.addMetrics(data, Source.SLICE, /* facetMap */ undefined, name);
        }
      });
    }
  }

  private async getMetrics(selectedInputs: IndexedInput[], model: string) {
    if (selectedInputs == null || selectedInputs.length === 0) return;
    const config =
        this.classificationService.marginSettings[model] as CallConfig || {};
    const metrics = await this.apiService.getInterpretations(
        selectedInputs, model, this.appState.currentDataset, 'metrics', config);
    return metrics;
  }

  /** Convert the metricsMap information into table data for display. */
  @computed
  get tableData(): TableHeaderAndData {
    const rows = [] as TableData[];
    const allMetricNames = new Set<string>();
    Object.values(this.metricsMap).forEach(row => {
      Object.keys(row.headMetrics).forEach(metricsType => {
        const metricsValues = row.headMetrics[metricsType];
        Object.keys(metricsValues).forEach(metricName => {
          allMetricNames.add(`${metricsType}: ${metricName}`);
        });
      });
    });

    const metricNames = [...allMetricNames];
    const nonMetricNames = ['Model', 'From', 'Field', 'N'];

    Object.values(this.metricsMap).forEach(row => {
      const rowMetrics = metricNames.map(metricKey => {
        const [metricsType, metricName] = metricKey.split(": ");
        if (row.headMetrics[metricsType] == null) {
          return '-';
        }
        const num = row.headMetrics[metricsType][metricName];
        if (num == null) {
          return '-';
        }
        // If the metric is not a whole number, then round to 3 decimal places.
        if (typeof num === 'number' && num % 1 !== 0) {
          return num.toFixed(3);
        }
        return num;
      });
      // Add the "Facet by" columns.
      const rowFacets = this.selectedFacets.map((facet: string) => {
        if (row.facets && row.facets[facet]) {
          return row.facets[facet];
        }
        return '-';
      });

      const tableRow = [
        rows.length, row.model, row.selection, row.predKey,
        row.exampleIds.length, ...rowFacets, ...rowMetrics];
      rows.push(tableRow);
    });

    return {
      'header':
          ["id", ...nonMetricNames, ...this.selectedFacets, ...metricNames],
      'data': rows
    };
  }

  render() {
    return html`
          <div class="metrics-module-wrapper">
            ${this.renderFacetSelector()}
            ${this.renderTable()}
          </div>
        `;
  }

  renderTable() {
    const columnNames = this.tableData.header;
    const columnVisibility = new Map<string, boolean>();
    columnNames.forEach((name) => {
      columnVisibility.set(name, name !== "id");
    });
    const onClick = (selectedIndex: number) => {
      const ids = Object.values(this.metricsMap)[selectedIndex].exampleIds;
      this.selectionService.selectIds(ids, this);
    };

    return html`
      <lit-data-table
        .columnVisibility=${columnVisibility}
        .data=${this.tableData.data}
        .onClick=${onClick}
      ></lit-data-table>
    `;
  }

  renderFacetSelector() {
    // Update the filterdict to match the checkboxes.
    const onFeatureCheckboxChange = (e: Event, key: string) => {
      if ((e.target as HTMLInputElement).checked) {
        this.selectedFacets.push(key);
      } else {
        const index = this.selectedFacets.indexOf(key);
        this.selectedFacets.splice(index, 1);
      }
      this.updateAllFacetedMetrics();
    };

    // Disable the "slices" on the dropdown if all the slices are empty.
    const slicesDisabled = this.sliceService.areAllSlicesEmpty();

    const onSlicesCheckboxChecked = (e: Event) => {
      this.facetBySlice = !this.facetBySlice;
      this.updateSliceMetrics();
    };
    // clang-format off
    return html`
    <div class="facet-selector">
      <label class="cb-label">Show slices</label>
      <lit-checkbox
        ?checked=${this.facetBySlice}
        @change=${onSlicesCheckboxChecked}
        ?disabled=${slicesDisabled}>
      </lit-checkbox>
      <label class="cb-label">Facet by</label>
       ${
        this.groupService.categoricalAndNumericalFeatureNames.map(
            facetName => this.renderCheckbox(facetName, false,
                (e: Event) => {onFeatureCheckboxChange(e, facetName);}, false))}
      ${this.pendingCalls > 0 ? this.renderSpinner() : null}
    </div>
    `;
    // clang-format on
  }

  private renderCheckbox(
      key: string, checked: boolean, onChange: (e: Event, key: string) => void,
      disabled: boolean) {
    // clang-format off
    return html`
        <div class='checkbox-holder'>
          <lit-checkbox
            ?checked=${checked}
            ?disabled=${disabled}
            @change='${(e: Event) => {onChange(e, key);}}'
            label=${key}>
          </lit-checkbox>
        </div>
    `;
    // clang-format on
  }

  renderSpinner() {
    return html`
      <lit-spinner size=${24} color="var(--app-secondary-color)">
      </lit-spinner>
    `;
  }

  static shouldDisplayModule(modelSpecs: ModelInfoMap, datasetSpec: Spec) {
    return true;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'metrics-module': MetricsModule;
  }
}
